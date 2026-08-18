using System;
using UnityEngine;

namespace TikTokLiveGame
{
    public static class BridgeRuntimeConfig
    {
        public const string BridgeHost = "127.0.0.1";
        public const int DefaultPort = 3100;

        public static int Port { get; }
        public static string BridgeWsUrl { get; }

        static BridgeRuntimeConfig()
        {
            Port = ResolvePort(Environment.GetCommandLineArgs());
            BridgeWsUrl = $"ws://{BridgeHost}:{Port}";
        }

        private static int ResolvePort(string[] args)
        {
            for (int index = 0; index < args.Length - 1; index++)
            {
                if (!string.Equals(args[index], "-bridgePort", StringComparison.OrdinalIgnoreCase)) continue;
                string raw = args[index + 1];
                if (int.TryParse(raw, out int port) && port >= 1 && port <= 65535)
                {
                    Debug.Log($"[Bridge] Nhan -bridgePort={port}");
                    return port;
                }
                Debug.LogWarning($"[Bridge] Cờ -bridgePort không hợp lệ \"{raw}\", dùng port mặc định {DefaultPort}.");
                return DefaultPort;
            }
            return DefaultPort;
        }
    }
}