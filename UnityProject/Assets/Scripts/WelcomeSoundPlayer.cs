using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEngine;
using UnityEngine.Networking;

namespace TikTokLiveGame
{
    // Chào khách khi có người vào phòng: nếu đã đặt âm thanh báo thì KÊU trước,
    // rồi tự động ĐỌC TÊN người vừa vào (gọi API TTS của Bridge).
    // Có hàng đợi + giãn cách + chống trùng tên để không loạn khi vào dồn dập.
    public sealed class WelcomeSoundPlayer : MonoBehaviour
    {
        private const float DefaultVolume = 0.6f;
        private const int MaxQueue = 4;
        private const float RepeatNameWindow = 60f; // không đọc lại cùng tên trong 60s.
        private const int MaxNameLength = 40;
        private const float ChimeMaxWait = 1.2f;

        private AudioSource output;
        private AudioClip chimeClip;
        private bool enabledByConfig = true;
        private float configuredVolume = DefaultVolume;
        private string greetingTemplate = "Chào mừng {ten}";
        private float minInterval = 4f;
        private string lang = "vi";
        private bool loadingChime;

        private readonly Queue<string> greetQueue = new();
        private readonly Dictionary<string, float> recentNames = new();

        private void Awake()
        {
            Application.runInBackground = true;
            output = gameObject.AddComponent<AudioSource>();
            output.playOnAwake = false;
            output.loop = false;
            output.spatialBlend = 0f;
            output.priority = 96;
            ReloadFromDisk();
            StartCoroutine(ProcessQueue());
        }

        public void SetEnabled(bool value) => enabledByConfig = value;
        public void SetInterval(float value) => minInterval = Mathf.Clamp(value, 1f, 30f);
        public void SetGreeting(string value)
        {
            if (!string.IsNullOrWhiteSpace(value)) greetingTemplate = value.Trim();
        }
        public void SetLang(string value)
        {
            if (!string.IsNullOrWhiteSpace(value)) lang = value.Trim();
        }
        public void SetConfiguredVolume(float value)
        {
            configuredVolume = Mathf.Clamp01(value);
            if (output != null) output.volume = configuredVolume;
        }

        // Nạp âm thanh báo (tuỳ chọn) từ thư mục DJ_SFX. Không có cũng không sao.
        public void ReloadFromDisk()
        {
            if (chimeClip != null) { Destroy(chimeClip); chimeClip = null; }
            string path = FindSound();
            if (string.IsNullOrEmpty(path))
            {
                Debug.Log("Welcome sound: chưa có âm thanh báo trong DJ_SFX (vẫn đọc tên khách).");
                return;
            }
            StartCoroutine(LoadChime(path));
        }

        // Gọi khi có người vào phòng, kèm tên hiển thị của khách.
        public void GreetMember(string nickname)
        {
            if (!enabledByConfig || output == null) return;
            string name = CleanName(nickname);
            if (string.IsNullOrEmpty(name)) return;

            // Chống đọc lại cùng một tên trong thời gian ngắn.
            float now = Time.unscaledTime;
            if (recentNames.TryGetValue(name, out float last) && now - last < RepeatNameWindow) return;
            recentNames[name] = now;
            if (recentNames.Count > 200) PruneRecentNames(now);

            if (greetQueue.Count >= MaxQueue) return; // quá tải thì bỏ bớt, tránh dồn ứ.
            greetQueue.Enqueue(name);
        }

        private IEnumerator ProcessQueue()
        {
            while (true)
            {
                if (greetQueue.Count == 0)
                {
                    yield return null;
                    continue;
                }
                string name = greetQueue.Dequeue();
                yield return StartCoroutine(GreetOne(name));
                float releaseAt = Time.unscaledTime + minInterval;
                while (Time.unscaledTime < releaseAt) yield return null;
            }
        }

        private IEnumerator GreetOne(string name)
        {
            // 1) Kêu âm thanh báo nếu đã thiết lập.
            if (chimeClip != null)
            {
                output.PlayOneShot(chimeClip, configuredVolume);
                float chimeUntil = Time.unscaledTime + Mathf.Min(chimeClip.length, ChimeMaxWait);
                while (Time.unscaledTime < chimeUntil) yield return null;
            }

            // 2) Đọc tên khách qua API TTS của Bridge.
            string text = greetingTemplate
                .Replace("{ten}", name)
                .Replace("{name}", name)
                .Replace("{Ten}", name);
            if (!text.Contains(name)) text = $"{text} {name}";

            string url = $"http://{BridgeRuntimeConfig.BridgeHost}:{BridgeRuntimeConfig.Port}" +
                         $"/api/tts?lang={UnityWebRequest.EscapeURL(lang)}&text={UnityWebRequest.EscapeURL(text)}";

            using UnityWebRequest request = UnityWebRequestMultimedia.GetAudioClip(url, AudioType.MPEG);
            yield return request.SendWebRequest();
            if (request.result != UnityWebRequest.Result.Success)
            {
                // Mạng lỗi thì thôi, âm thanh báo (nếu có) đã kêu ở bước trên.
                Debug.LogWarning($"Welcome voice failed for '{name}': {request.error}");
                yield break;
            }

            AudioClip clip = DownloadHandlerAudioClip.GetContent(request);
            if (clip == null) yield break;
            output.volume = configuredVolume;
            output.clip = clip;
            output.Play();
            float timeout = Time.unscaledTime + clip.length + 1.5f;
            yield return new WaitUntil(() => !output.isPlaying || Time.unscaledTime > timeout);
            output.clip = null;
            Destroy(clip);
        }

        private IEnumerator LoadChime(string path)
        {
            loadingChime = true;
            AudioType type = AudioTypeFor(path);
            string uri = new Uri(path).AbsoluteUri;
            using UnityWebRequest request = UnityWebRequestMultimedia.GetAudioClip(uri, type);
            yield return request.SendWebRequest();
            loadingChime = false;
            if (request.result != UnityWebRequest.Result.Success)
            {
                Debug.LogWarning($"Welcome sound could not load '{path}': {request.error}");
                yield break;
            }
            AudioClip loaded = DownloadHandlerAudioClip.GetContent(request);
            if (loaded == null) yield break;
            loaded.name = $"Welcome {Path.GetFileName(path)}";
            chimeClip = loaded;
            Debug.Log($"Welcome sound loaded: {path}");
        }

        private static string CleanName(string nickname)
        {
            string name = (nickname ?? string.Empty).Trim();
            if (name.Length > MaxNameLength) name = name.Substring(0, MaxNameLength).Trim();
            return name;
        }

        private void PruneRecentNames(float now)
        {
            List<string> stale = recentNames
                .Where(pair => now - pair.Value >= RepeatNameWindow)
                .Select(pair => pair.Key)
                .ToList();
            foreach (string key in stale) recentNames.Remove(key);
        }

        private static AudioType AudioTypeFor(string path)
        {
            return Path.GetExtension(path).ToLowerInvariant() switch
            {
                ".wav" => AudioType.WAV,
                ".ogg" => AudioType.OGGVORBIS,
                _ => AudioType.MPEG
            };
        }

        private static string FindSound()
        {
            string buildRoot = Directory.GetParent(Application.dataPath)?.FullName ?? Application.dataPath;
            string projectRoot = Directory.GetParent(buildRoot)?.FullName ?? buildRoot;
            string workspaceRoot = Directory.GetParent(projectRoot)?.FullName ?? projectRoot;
            string[] folders =
            {
                Path.Combine(buildRoot, "DJ_SFX"),
                Path.Combine(projectRoot, "DJ_SFX"),
                Path.Combine(workspaceRoot, "DJ_SFX"),
                Application.streamingAssetsPath
            };
            string[] extensions = { ".wav", ".mp3", ".ogg" };
            foreach (string folder in folders)
            {
                if (!Directory.Exists(folder)) continue;
                // Ưu tiên âm thanh người dùng đã chọn trong Control Panel.
                string selectedPath = Path.Combine(folder, "SELECTED_WELCOME.txt");
                if (File.Exists(selectedPath))
                {
                    string selectedName = File.ReadAllText(selectedPath).Trim();
                    string candidate = Path.Combine(folder, selectedName);
                    if (!string.IsNullOrEmpty(selectedName) && File.Exists(candidate) &&
                        extensions.Contains(Path.GetExtension(candidate), StringComparer.OrdinalIgnoreCase))
                        return candidate;
                }
                string preferred = extensions
                    .Select(ext => Path.Combine(folder, $"welcome{ext}"))
                    .FirstOrDefault(File.Exists);
                if (!string.IsNullOrEmpty(preferred)) return preferred;
                string any = Directory.EnumerateFiles(folder)
                    .Where(candidate => extensions.Contains(Path.GetExtension(candidate), StringComparer.OrdinalIgnoreCase))
                    .OrderBy(candidate => Path.GetFileName(candidate), StringComparer.OrdinalIgnoreCase)
                    .FirstOrDefault();
                if (!string.IsNullOrEmpty(any)) return any;
            }
            return string.Empty;
        }

        private void OnDestroy()
        {
            StopAllCoroutines();
            if (chimeClip != null) Destroy(chimeClip);
        }
    }
}
