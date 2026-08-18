# -*- coding: utf-8 -*-
"""
TISO Live — trình cài đặt (web installer).

Chọn thư mục cài, tải bản phát hành mới nhất từ GitHub Releases, giải nén, ghi đè
(giữ lại cấu hình/bản quyền/nhạc của người dùng khi cập nhật) và tạo shortcut run.bat.

Build ra exe:  pyinstaller --onefile --windowed --name TISO_Live_Setup tiso_installer.py
"""

import json
import os
import shutil
import ssl
import subprocess
import sys
import tempfile
import threading
import urllib.request
import zipfile

import tkinter as tk
from tkinter import filedialog, ttk

REPO = "AnhTuan2003ml/tiktok-live-bar"
APP_NAME = "TISO Live Control"

# Những thứ thuộc về máy người dùng — cập nhật không ghi đè.
PRESERVE = [
    r"TikTokBridge\.env",
    r"TikTokBridge\config\operator.json",
    r"TikTokBridge\config\observed-gifts.json",
    r"TikTokBridge\config\master.json",
    r"TikTokBridge\config\.license.dat",
    r"TikTokBridge\config\.activation.dat",
    "DJ_MUSIC",
    "DJ_VIDEO",
    "LiveAssets",
]


def default_dir():
    base = os.environ.get("LOCALAPPDATA", os.path.expanduser("~"))
    return os.path.join(base, "TISO Live")


def http_json(url):
    req = urllib.request.Request(url, headers={
        "User-Agent": "TISO-Installer",
        "Accept": "application/vnd.github+json",
    })
    ctx = ssl.create_default_context()
    with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
        return json.loads(resp.read().decode("utf-8"))


def latest_zip_asset():
    data = http_json("https://api.github.com/repos/%s/releases/latest" % REPO)
    tag = data.get("tag_name", "")
    for asset in data.get("assets", []):
        if str(asset.get("name", "")).lower().endswith(".zip"):
            return tag, asset["name"], asset["browser_download_url"], int(asset.get("size", 0))
    raise RuntimeError(
        "Ban phat hanh %s tren GitHub chua co file ZIP nao de tai.\n"
        "Hay upload goi (TISO-Live-Windows.zip) vao release truoc." % (tag or "moi nhat")
    )


def stop_running_apps(target_dir):
    target = os.path.normcase(os.path.abspath(target_dir))
    # Đóng game và Bridge thuộc đúng thư mục cài đặt (không đụng bản khác đang chạy).
    ps = (
        "$t=[System.IO.Path]::GetFullPath('%s');"
        "Get-CimInstance Win32_Process -Filter \"Name='TISO.exe'\" -ErrorAction SilentlyContinue |"
        " Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($t,'OrdinalIgnoreCase') } |"
        " ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue };"
        "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" -ErrorAction SilentlyContinue |"
        " Where-Object { $_.CommandLine -and $_.CommandLine -match 'server\\.js' -and $_.CommandLine -like ('*'+$t+'*') } |"
        " ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
    ) % target.replace("'", "''")
    run_powershell(ps)


def run_powershell(script):
    creationflags = 0x08000000  # CREATE_NO_WINDOW
    subprocess.run(
        ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
        creationflags=creationflags, capture_output=True,
    )


def backup_user_data(target_dir, backup_dir):
    saved = []
    for rel in PRESERVE:
        src = os.path.join(target_dir, rel)
        if not os.path.exists(src):
            continue
        dst = os.path.join(backup_dir, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if os.path.isdir(src):
            shutil.copytree(src, dst, dirs_exist_ok=True)
        else:
            run_powershell("attrib -h -s '%s'" % src.replace("'", "''"))
            shutil.copy2(src, dst)
        saved.append(rel)
    return saved


def restore_user_data(target_dir, backup_dir, saved):
    for rel in saved:
        src = os.path.join(backup_dir, rel)
        if not os.path.exists(src):
            continue
        dst = os.path.join(target_dir, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if os.path.isdir(src):
            shutil.copytree(src, dst, dirs_exist_ok=True)
        else:
            shutil.copy2(src, dst)


def make_shortcut(link_path, target_dir):
    run_bat = os.path.join(target_dir, "run.bat")
    icon = os.path.join(target_dir, "Build", "TISO.exe")
    icon_line = "$s.IconLocation='%s';" % icon.replace("'", "''") if os.path.exists(icon) else ""
    ps = (
        "$w=New-Object -ComObject WScript.Shell;"
        "$s=$w.CreateShortcut('%s');"
        "$s.TargetPath='%s';"
        "$s.WorkingDirectory='%s';"
        "$s.Description='%s';"
        "%s"
        "$s.Save()"
    ) % (
        link_path.replace("'", "''"),
        run_bat.replace("'", "''"),
        target_dir.replace("'", "''"),
        APP_NAME,
        icon_line,
    )
    run_powershell(ps)


def desktop_dir():
    return run_powershell_out("[Environment]::GetFolderPath('Desktop')")


def programs_dir():
    return run_powershell_out("[Environment]::GetFolderPath('Programs')")


def run_powershell_out(expr):
    creationflags = 0x08000000
    out = subprocess.run(
        ["powershell.exe", "-NoProfile", "-Command", "Write-Output (%s)" % expr],
        creationflags=creationflags, capture_output=True, text=True,
    )
    return out.stdout.strip()


class Installer(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("TISO Live — Cài đặt")
        self.geometry("560x300")
        self.resizable(False, False)
        self.configure(bg="#10151f")
        self.install_dir = tk.StringVar(value=default_dir())
        self._build_ui()

    def _build_ui(self):
        fg = "#e9edf7"
        muted = "#98a3ba"
        style = ttk.Style(self)
        try:
            style.theme_use("clam")
        except tk.TclError:
            pass
        style.configure("TProgressbar", troughcolor="#1c2331", background="#6d7cff")

        tk.Label(self, text="Cài đặt TISO Live Control", bg="#10151f", fg=fg,
                 font=("Segoe UI", 15, "bold")).pack(anchor="w", padx=22, pady=(20, 2))
        tk.Label(self, text="Tải bản mới nhất từ GitHub và cài vào thư mục bạn chọn.\nCần kết nối Internet (gói khoảng 150 MB).",
                 bg="#10151f", fg=muted, font=("Segoe UI", 9), justify="left").pack(anchor="w", padx=22)

        row = tk.Frame(self, bg="#10151f")
        row.pack(fill="x", padx=22, pady=(18, 6))
        tk.Label(row, text="THƯ MỤC CÀI ĐẶT", bg="#10151f", fg=muted,
                 font=("Segoe UI", 8, "bold")).pack(anchor="w")
        row2 = tk.Frame(self, bg="#10151f")
        row2.pack(fill="x", padx=22)
        self.entry = tk.Entry(row2, textvariable=self.install_dir, bg="#080b13", fg=fg,
                              insertbackground=fg, relief="flat", font=("Segoe UI", 10))
        self.entry.pack(side="left", fill="x", expand=True, ipady=6, padx=(0, 8))
        self.browse_btn = tk.Button(row2, text="Chọn…", command=self.choose_dir,
                                    bg="#1c2331", fg=fg, relief="flat", font=("Segoe UI", 9),
                                    activebackground="#232c3e", activeforeground=fg, cursor="hand2")
        self.browse_btn.pack(side="right", ipadx=10, ipady=3)

        self.status = tk.Label(self, text="Sẵn sàng cài đặt.", bg="#10151f", fg=muted,
                               font=("Segoe UI", 9), anchor="w")
        self.status.pack(fill="x", padx=22, pady=(18, 4))
        self.bar = ttk.Progressbar(self, mode="determinate", maximum=100)
        self.bar.pack(fill="x", padx=22)

        self.install_btn = tk.Button(self, text="Cài đặt", command=self.start_install,
                                     bg="#6d7cff", fg="#ffffff", relief="flat",
                                     font=("Segoe UI", 11, "bold"), cursor="hand2",
                                     activebackground="#5a68e0", activeforeground="#ffffff")
        self.install_btn.pack(fill="x", padx=22, pady=(20, 18), ipady=8)

    def choose_dir(self):
        chosen = filedialog.askdirectory(title="Chọn thư mục cài đặt TISO Live",
                                         initialdir=self.install_dir.get())
        if chosen:
            self.install_dir.set(os.path.normpath(chosen))

    def set_status(self, text, progress=None, color="#98a3ba"):
        self.status.config(text=text, fg=color)
        if progress is not None:
            self.bar["value"] = progress
        self.update_idletasks()

    def start_install(self):
        self.install_btn.config(state="disabled")
        self.browse_btn.config(state="disabled")
        threading.Thread(target=self._install_worker, daemon=True).start()

    def _install_worker(self):
        try:
            target = os.path.abspath(self.install_dir.get())
            self.set_status("Đang kiểm tra bản phát hành mới nhất…", 5)
            tag, name, url, size = latest_zip_asset()

            with tempfile.TemporaryDirectory(prefix="tiso-setup-") as tmp:
                zip_path = os.path.join(tmp, name)
                self._download(url, zip_path, size)

                self.set_status("Đang đóng ứng dụng đang chạy…", 70)
                stop_running_apps(target)

                backup = os.path.join(tmp, "giu-lai")
                saved = []
                if os.path.isdir(target):
                    saved = backup_user_data(target, backup)

                self.set_status("Đang giải nén và ghi đè…", 78)
                extract = os.path.join(tmp, "giai-nen")
                with zipfile.ZipFile(zip_path) as zf:
                    zf.extractall(extract)

                root = extract
                if not os.path.exists(os.path.join(root, "run.bat")):
                    subdirs = [d for d in os.listdir(extract)
                               if os.path.isdir(os.path.join(extract, d))
                               and os.path.exists(os.path.join(extract, d, "run.bat"))]
                    if subdirs:
                        root = os.path.join(extract, subdirs[0])

                os.makedirs(target, exist_ok=True)
                self._copy_tree(root, target)

                if saved:
                    restore_user_data(target, backup, saved)

                self.set_status("Đang tạo shortcut…", 92)
                self._make_shortcuts(target)

                with open(os.path.join(target, "VERSION.json"), "w", encoding="utf-8") as f:
                    json.dump({"tag": tag, "source": url}, f, ensure_ascii=False, indent=2)

            self.set_status("Đã cài đặt xong bản %s. Mở app bằng shortcut trên Desktop hoặc run.bat." % tag,
                            100, color="#34d399")
            self.install_btn.config(text="Đóng", command=self.destroy, state="normal", bg="#34d399")
        except Exception as error:  # noqa: BLE001
            self.set_status("Lỗi: %s" % error, color="#fb5c72")
            self.install_btn.config(state="normal")
            self.browse_btn.config(state="normal")

    def _download(self, url, dest, total):
        req = urllib.request.Request(url, headers={"User-Agent": "TISO-Installer"})
        ctx = ssl.create_default_context()
        with urllib.request.urlopen(req, timeout=1800, context=ctx) as resp, open(dest, "wb") as out:
            downloaded = 0
            chunk = 1024 * 256
            while True:
                block = resp.read(chunk)
                if not block:
                    break
                out.write(block)
                downloaded += len(block)
                if total:
                    pct = 5 + int(downloaded / total * 60)
                    self.set_status("Đang tải %s… %.0f/%.0f MB"
                                    % (os.path.basename(dest), downloaded / 1048576, total / 1048576),
                                    min(pct, 65))

    def _copy_tree(self, src, dst):
        for entry in os.listdir(src):
            s = os.path.join(src, entry)
            d = os.path.join(dst, entry)
            if os.path.isdir(s):
                shutil.copytree(s, d, dirs_exist_ok=True)
            else:
                os.makedirs(os.path.dirname(d), exist_ok=True)
                shutil.copy2(s, d)

    def _make_shortcuts(self, target):
        desk = desktop_dir()
        if desk:
            make_shortcut(os.path.join(desk, APP_NAME + ".lnk"), target)
        progs = programs_dir()
        if progs:
            group = os.path.join(progs, APP_NAME)
            os.makedirs(group, exist_ok=True)
            make_shortcut(os.path.join(group, APP_NAME + ".lnk"), target)


if __name__ == "__main__":
    Installer().mainloop()
