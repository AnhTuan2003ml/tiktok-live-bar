using System;
using System.IO;
using System.Linq;
using UnityEngine;
using UnityEngine.Video;

namespace TikTokLiveGame
{
    // Phủ video (hoặc ảnh PNG) logo lên góc dưới bên phải khung live, để OBS bắt được.
    // Vẽ bằng OnGUI nên độc lập với màn hình DJ trong sân, chỉnh được cỡ và độ mờ.
    public sealed class LogoVideoOverlay : MonoBehaviour
    {
        private const float DefaultScale = 0.18f;   // theo chiều cao màn hình

        private VideoPlayer player;
        private RenderTexture videoSourceTexture;
        private Texture2D imageTexture;

        private bool enabledByConfig = true;
        private float configuredScale = DefaultScale;
        private float configuredOpacity = 1f;
        private float mediaAspect = 16f / 9f;
        private bool hasMedia;

        private void Awake() => Application.runInBackground = true;

        private void Start() => ReloadFromDisk();

        public void SetEnabled(bool value) => enabledByConfig = value;
        public void SetScale(float value) => configuredScale = Mathf.Clamp(value, 0.05f, 0.6f);
        public void SetOpacity(float value) => configuredOpacity = Mathf.Clamp01(value);

        public void ReloadFromDisk()
        {
            ReleaseMedia();
            string video = FindMedia(new[] { ".mp4", ".mov", ".m4v", ".webm" });
            if (!string.IsNullOrEmpty(video))
            {
                StartVideo(video);
                return;
            }
            string image = FindMedia(new[] { ".png", ".jpg", ".jpeg" });
            if (!string.IsNullOrEmpty(image))
            {
                LoadImage(image);
                return;
            }
            Debug.Log("Logo overlay is ready. Add a MP4/WEBM video or PNG image to the DJ_LOGO folder.");
        }

        private void StartVideo(string path)
        {
            videoSourceTexture = new RenderTexture(640, 640, 0, RenderTextureFormat.ARGB32)
            {
                name = "Logo Source Texture",
                filterMode = FilterMode.Bilinear,
                wrapMode = TextureWrapMode.Clamp
            };
            videoSourceTexture.Create();

            player = gameObject.AddComponent<VideoPlayer>();
            player.playOnAwake = false;
            player.isLooping = true;
            player.source = VideoSource.Url;
            player.url = new Uri(path).AbsoluteUri;
            player.renderMode = VideoRenderMode.RenderTexture;
            player.targetTexture = videoSourceTexture;
            player.audioOutputMode = VideoAudioOutputMode.None;
            player.skipOnDrop = true;
            player.errorReceived += (_, message) => Debug.LogWarning($"Logo video could not play: {message}");
            player.prepareCompleted += source =>
            {
                if (source.height > 0) mediaAspect = source.width / (float)source.height;
                hasMedia = true;
                source.Play();
            };
            player.Prepare();
            Debug.Log($"Logo video loaded: {path}");
        }

        private void LoadImage(string path)
        {
            byte[] bytes;
            try { bytes = File.ReadAllBytes(path); }
            catch (Exception exception)
            {
                Debug.LogWarning($"Logo image could not be read: {exception.Message}");
                return;
            }
            Texture2D texture = new(2, 2, TextureFormat.RGBA32, false)
            {
                name = $"Logo {Path.GetFileName(path)}",
                filterMode = FilterMode.Bilinear,
                wrapMode = TextureWrapMode.Clamp
            };
            if (!texture.LoadImage(bytes, false))
            {
                Destroy(texture);
                Debug.LogWarning($"Logo image format is not supported: {path}");
                return;
            }
            imageTexture = texture;
            mediaAspect = texture.height > 0 ? texture.width / (float)texture.height : mediaAspect;
            hasMedia = true;
            Debug.Log($"Logo image loaded: {path}");
        }

        private void OnGUI()
        {
            if (!enabledByConfig || !hasMedia) return;
            // Vẽ thẳng texture nguồn: GUI.DrawTexture đã hiển thị RenderTexture đúng chiều,
            // không cần blit lật nữa (lật thêm sẽ làm video úp ngược).
            Texture drawTexture = videoSourceTexture != null ? (Texture)videoSourceTexture : imageTexture;
            if (drawTexture == null) return;

            float height = Screen.height * configuredScale;
            float width = height * (mediaAspect > 0.01f ? mediaAspect : 1f);
            // Sát hẳn mép dưới bên phải của khung live, không chừa lề.
            float x = Screen.width - width;
            float y = Screen.height - height;

            Color previous = GUI.color;
            GUI.color = new Color(1f, 1f, 1f, configuredOpacity);
            GUI.DrawTexture(new Rect(x, y, width, height), drawTexture, ScaleMode.ScaleToFit, true);
            GUI.color = previous;
        }

        private static string FindMedia(string[] extensions)
        {
            string buildRoot = Directory.GetParent(Application.dataPath)?.FullName ?? Application.dataPath;
            string projectRoot = Directory.GetParent(buildRoot)?.FullName ?? buildRoot;
            string workspaceRoot = Directory.GetParent(projectRoot)?.FullName ?? projectRoot;
            string[] folders =
            {
                Path.Combine(buildRoot, "DJ_LOGO"),
                Path.Combine(projectRoot, "DJ_LOGO"),
                Path.Combine(workspaceRoot, "DJ_LOGO"),
                Application.streamingAssetsPath
            };
            foreach (string folder in folders)
            {
                if (!Directory.Exists(folder)) continue;
                string file = Directory.EnumerateFiles(folder)
                    .Where(candidate => extensions.Contains(Path.GetExtension(candidate), StringComparer.OrdinalIgnoreCase))
                    .OrderBy(candidate => Path.GetFileName(candidate), StringComparer.OrdinalIgnoreCase)
                    .FirstOrDefault();
                if (!string.IsNullOrEmpty(file)) return file;
            }
            return string.Empty;
        }

        private void ReleaseMedia()
        {
            hasMedia = false;
            if (player != null)
            {
                player.Stop();
                Destroy(player);
                player = null;
            }
            if (videoSourceTexture != null)
            {
                videoSourceTexture.Release();
                Destroy(videoSourceTexture);
                videoSourceTexture = null;
            }
            if (imageTexture != null)
            {
                Destroy(imageTexture);
                imageTexture = null;
            }
        }

        private void OnDestroy() => ReleaseMedia();
    }
}
