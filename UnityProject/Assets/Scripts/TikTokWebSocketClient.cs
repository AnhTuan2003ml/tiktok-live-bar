using System;
using System.Collections.Concurrent;
using System.IO;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using UnityEngine;

namespace TikTokLiveGame
{
    public sealed class TikTokWebSocketClient : MonoBehaviour
    {
        private string serverUrl = BridgeRuntimeConfig.BridgeWsUrl;
        [SerializeField] private int reconnectDelayMs = 2000;
        [SerializeField] private int maxEventsPerFrame = 20;
        [SerializeField] private int maxQueuedMessages = 1500;
        [SerializeField] private float telemetryIntervalSeconds = 1f;

        private readonly ConcurrentQueue<string> inbox = new();
        private ClientWebSocket socket;
        private CancellationTokenSource lifetime;
        private Task supervisor;
        private long lastPongTicks;
        private int droppedMessages;
        private float telemetryTimer;
        private float smoothedFps = 60f;
        private PlayerManager telemetryPlayers;
        private TikTokGameController telemetryGame;
        private static TikTokWebSocketClient instance;

        public event Action<TikTokEvent> EventReceived;
        public bool IsConnected => socket != null && socket.State == WebSocketState.Open;
        public string ServerUrl => serverUrl;
        public int QueueCount => inbox.Count;
        public int DroppedMessages => Volatile.Read(ref droppedMessages);

        public void ConfigureTelemetry(PlayerManager players, TikTokGameController game)
        {
            telemetryPlayers = players;
            telemetryGame = game;
        }

        private void OnEnable()
        {
            if (instance != null && instance != this)
            {
                Destroy(this);
                return;
            }
            instance = this;
            serverUrl = BridgeRuntimeConfig.BridgeWsUrl;
            Debug.Log($"[Bridge] Connecting to {serverUrl}");
            lifetime = new CancellationTokenSource();
            supervisor = RunConnectionSupervisorAsync(lifetime.Token);
        }

        private void Update()
        {
            float delta = Mathf.Max(0.0001f, Time.unscaledDeltaTime);
            float instantaneousFps = 1f / delta;
            smoothedFps = Mathf.Lerp(smoothedFps, instantaneousFps, 0.08f);

            int processed = 0;
            int budget = Mathf.Clamp(maxEventsPerFrame, 1, 200);
            while (processed < budget && inbox.TryDequeue(out string json))
            {
                processed += 1;
                try
                {
                    TikTokEvent liveEvent = JsonUtility.FromJson<TikTokEvent>(json);
                    if (liveEvent != null && !string.IsNullOrWhiteSpace(liveEvent.type))
                        EventReceived?.Invoke(liveEvent);
                }
                catch (Exception exception)
                {
                    Debug.LogWarning($"TikTok event JSON was ignored: {exception.Message}");
                }
            }

            telemetryTimer += delta;
            if (telemetryTimer >= Mathf.Max(0.5f, telemetryIntervalSeconds))
            {
                telemetryTimer = 0f;
                SendTelemetry();
            }
        }

        private void SendTelemetry()
        {
            if (!IsConnected) return;
            Send(new ClientMessage
            {
                type = "game_telemetry",
                fps = Mathf.Clamp(smoothedFps, 0f, 500f),
                queueCount = QueueCount,
                playerCount = telemetryPlayers != null ? telemetryPlayers.Count : 0,
                droppedMessages = DroppedMessages,
                chroma = telemetryGame != null && telemetryGame.IsChromaMode,
                hud = telemetryGame != null && telemetryGame.IsHudVisible,
                feed = telemetryGame != null && telemetryGame.IsFeedVisible,
                controls = telemetryGame != null && telemetryGame.AreControlsVisible,
                fullscreen = Screen.fullScreen
            });
        }

        private async Task RunConnectionSupervisorAsync(CancellationToken token)
        {
            while (!token.IsCancellationRequested)
            {
                ClientWebSocket activeSocket = new();
                socket = activeSocket;
                try
                {
                    await activeSocket.ConnectAsync(new Uri(serverUrl), token);
                    Interlocked.Exchange(ref lastPongTicks, DateTime.UtcNow.Ticks);
                    Debug.Log($"Connected to TikTok Node bridge at {serverUrl}");
                    string registration = JsonUtility.ToJson(new ClientMessage
                    {
                        type = "register",
                        role = "overlay"
                    });
                    await SendRawAsync(activeSocket, registration, token);

                    using CancellationTokenSource connectionLifetime = CancellationTokenSource.CreateLinkedTokenSource(token);
                    Task receiver = ReceiveLoopAsync(activeSocket, connectionLifetime.Token);
                    Task heartbeat = HeartbeatLoopAsync(activeSocket, connectionLifetime.Token);
                    await Task.WhenAny(receiver, heartbeat);
                    connectionLifetime.Cancel();
                    try { await receiver; } catch when (!token.IsCancellationRequested) { }
                    try { await heartbeat; } catch when (!token.IsCancellationRequested) { }
                }
                catch (OperationCanceledException) when (token.IsCancellationRequested)
                {
                    break;
                }
                catch (Exception exception)
                {
                    if (!token.IsCancellationRequested)
                        Debug.LogWarning($"TikTok bridge unavailable: {exception.Message}");
                }
                finally
                {
                    if (ReferenceEquals(socket, activeSocket)) socket = null;
                    try { activeSocket.Abort(); } catch { }
                    activeSocket.Dispose();
                }

                if (token.IsCancellationRequested) break;
                try { await Task.Delay(reconnectDelayMs, token); }
                catch (OperationCanceledException) { break; }
            }
        }

        private async Task ReceiveLoopAsync(ClientWebSocket activeSocket, CancellationToken token)
        {
            byte[] buffer = new byte[16 * 1024];
            while (!token.IsCancellationRequested && activeSocket.State == WebSocketState.Open)
            {
                using MemoryStream message = new();
                WebSocketReceiveResult result;
                do
                {
                    result = await activeSocket.ReceiveAsync(new ArraySegment<byte>(buffer), token);
                    if (result.MessageType == WebSocketMessageType.Close) return;
                    message.Write(buffer, 0, result.Count);
                } while (!result.EndOfMessage);

                string json = Encoding.UTF8.GetString(message.ToArray());
                if (json.Contains("\"type\":\"pong\"", StringComparison.Ordinal))
                {
                    Interlocked.Exchange(ref lastPongTicks, DateTime.UtcNow.Ticks);
                    continue;
                }

                EnqueueMessage(json);
            }
        }

        private void EnqueueMessage(string json)
        {
            int cap = Math.Max(100, Math.Min(10000, maxQueuedMessages));
            if (inbox.Count >= cap && IsLowPriorityFloodEvent(json))
            {
                Interlocked.Increment(ref droppedMessages);
                return;
            }

            while (inbox.Count >= cap && inbox.TryDequeue(out _))
                Interlocked.Increment(ref droppedMessages);
            inbox.Enqueue(json);
        }

        private static bool IsLowPriorityFloodEvent(string json)
        {
            return json.Contains("\"type\":\"like\"", StringComparison.Ordinal) ||
                   json.Contains("\"type\":\"member\"", StringComparison.Ordinal);
        }

        private async Task HeartbeatLoopAsync(ClientWebSocket activeSocket, CancellationToken token)
        {
            while (!token.IsCancellationRequested && activeSocket.State == WebSocketState.Open)
            {
                await Task.Delay(2000, token);
                await SendRawAsync(activeSocket, "{\"type\":\"ping\"}", token);
                long elapsedTicks = DateTime.UtcNow.Ticks - Interlocked.Read(ref lastPongTicks);
                if (elapsedTicks > TimeSpan.FromSeconds(7).Ticks)
                    throw new TimeoutException("Node heartbeat timed out");
            }
        }

        private static async Task SendRawAsync(ClientWebSocket activeSocket, string json, CancellationToken token)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(json);
            await activeSocket.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, token);
        }

        private async void Send(ClientMessage message)
        {
            ClientWebSocket activeSocket = socket;
            CancellationTokenSource tokenSource = lifetime;
            if (activeSocket == null || activeSocket.State != WebSocketState.Open || tokenSource == null) return;
            try
            {
                await SendRawAsync(activeSocket, JsonUtility.ToJson(message), tokenSource.Token);
            }
            catch (Exception exception)
            {
                if (!tokenSource.IsCancellationRequested)
                    Debug.LogWarning($"Could not send to TikTok bridge: {exception.Message}");
                try { activeSocket.Abort(); } catch { }
            }
        }

        public void ConnectTikTok(string username) => Send(new ClientMessage
        {
            type = "set_username",
            username = username?.Trim().TrimStart('@')
        });

        public void DisconnectTikTok() => Send(new ClientMessage { type = "disconnect_tiktok" });
        public void StartDemo(int count) => Send(new ClientMessage { type = "demo_start", count = count });
        public void StopDemo() => Send(new ClientMessage { type = "demo_stop" });
        public void ResetGame() => Send(new ClientMessage { type = "reset_game" });
        public void DemoGift(int diamonds, int userIndex = 1) => Send(new ClientMessage
        {
            type = "demo_event",
            action = "gift",
            value = diamonds,
            userIndex = userIndex
        });

        private async void OnDisable()
        {
            lifetime?.Cancel();
            try { socket?.Abort(); } catch { }
            if (supervisor != null)
            {
                try { await supervisor; } catch { }
            }
            lifetime?.Dispose();
            lifetime = null;
            socket = null;
            while (inbox.TryDequeue(out _)) { }
            if (instance == this) instance = null;
        }
    }
}
