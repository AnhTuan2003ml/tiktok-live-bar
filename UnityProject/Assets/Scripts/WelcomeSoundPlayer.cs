using System;
using System.Collections;
using System.IO;
using System.Linq;
using UnityEngine;
using UnityEngine.Networking;

namespace TikTokLiveGame
{
    // Phát âm thanh chào mỗi khi có người vào phòng (sự kiện member).
    // Dùng AudioSource riêng để chồng lên nhạc nền, và chống spam khi nhiều
    // người vào cùng lúc bằng khoảng nghỉ tối thiểu giữa hai lần phát.
    public sealed class WelcomeSoundPlayer : MonoBehaviour
    {
        private const float DefaultVolume = 0.6f;
        private const float MinInterval = 0.7f;

        private AudioSource output;
        private AudioClip clip;
        private bool enabledByConfig = true;
        private float configuredVolume = DefaultVolume;
        private float lastPlayedAt = -10f;
        private bool loading;
        private string sourcePath = string.Empty;

        private void Awake()
        {
            Application.runInBackground = true;
            output = gameObject.AddComponent<AudioSource>();
            output.playOnAwake = false;
            output.loop = false;
            output.spatialBlend = 0f;
            output.priority = 96; // ưu tiên cao hơn nhạc nền để tiếng chào rõ.
            ReloadFromDisk();
        }

        public void SetEnabled(bool value) => enabledByConfig = value;

        public void SetConfiguredVolume(float value)
        {
            configuredVolume = Mathf.Clamp01(value);
            if (output != null) output.volume = configuredVolume;
        }

        public void ReloadFromDisk()
        {
            StopAllCoroutines();
            if (clip != null) { Destroy(clip); clip = null; }
            sourcePath = FindSound();
            if (string.IsNullOrEmpty(sourcePath))
            {
                Debug.Log("Welcome sound is ready. Add a WAV/MP3/OGG file to the DJ_SFX folder.");
                return;
            }
            StartCoroutine(LoadClip(sourcePath));
        }

        // Gọi khi có người vào phòng.
        public void PlayWelcome()
        {
            if (!enabledByConfig || output == null || clip == null || loading) return;
            if (Time.unscaledTime - lastPlayedAt < MinInterval) return;
            lastPlayedAt = Time.unscaledTime;
            output.volume = configuredVolume;
            output.PlayOneShot(clip, configuredVolume);
        }

        private IEnumerator LoadClip(string path)
        {
            loading = true;
            AudioType type = AudioTypeFor(path);
            string uri = new Uri(path).AbsoluteUri;
            using UnityWebRequest request = UnityWebRequestMultimedia.GetAudioClip(uri, type);
            yield return request.SendWebRequest();
            loading = false;
            if (request.result != UnityWebRequest.Result.Success)
            {
                Debug.LogWarning($"Welcome sound could not load '{path}': {request.error}");
                yield break;
            }
            AudioClip loaded = DownloadHandlerAudioClip.GetContent(request);
            if (loaded == null)
            {
                Debug.LogWarning($"Welcome sound decoder returned nothing for '{path}'.");
                yield break;
            }
            loaded.name = $"Welcome {Path.GetFileName(path)}";
            clip = loaded;
            Debug.Log($"Welcome sound loaded: {path}");
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
                // Ưu tiên file tên "welcome.*" nếu có, nếu không lấy file âm thanh đầu tiên.
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
            if (clip != null) Destroy(clip);
        }
    }
}
