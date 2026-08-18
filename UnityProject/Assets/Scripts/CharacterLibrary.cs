using System;
using System.Collections.Generic;
using System.Linq;
using UnityEngine;

namespace TikTokLiveGame
{
    public static class CharacterLibrary
    {
        private static readonly string[] Names =
        {
            "a", "b", "c", "d", "e", "g", "h", "j", "k",
            "mushroom_dance_01", "mushroom_dance_15", "mushroom_magic_02",
            "hanhan_video_dance"
        };

        private static readonly Dictionary<string, Sprite[]> Cache = new();

        // Kiểm tra tên nhân vật hợp lệ và lấy khung hình cho đúng nhân vật đó
        // (dùng để khôi phục nhân vật khách đã đổi trong phiên).
        public static bool Has(string name) => !string.IsNullOrEmpty(name) && Names.Contains(name);

        public static Sprite[] FramesFor(string name) => Load(name);

        public static (string name, Sprite[] frames) RandomCharacter(string except = null)
        {
            string[] choices = Names.Where(name => name != except).ToArray();
            string name = choices[UnityEngine.Random.Range(0, choices.Length)];
            return (name, Load(name));
        }

        private static Sprite[] Load(string name)
        {
            if (Cache.TryGetValue(name, out Sprite[] cached)) return cached;
            Sprite[] frames = Resources.LoadAll<Sprite>($"Characters/{name}")
                .OrderBy(sprite => sprite.name, StringComparer.Ordinal)
                .ToArray();
            Cache[name] = frames;
            return frames;
        }
    }
}
