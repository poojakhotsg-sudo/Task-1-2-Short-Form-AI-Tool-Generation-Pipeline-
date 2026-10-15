"""
drive_upload.py - stage 6: upload a tool's outputs to Google Drive.

Creates "NN - <Tool Name>" inside the AI Tools folder (DRIVE_FOLDER_ID in .env),
where NN is the next free number, and uploads:
    clips/ (mp4 + png), script.txt, shot_list.json, manifest.json, summary.md, rough_cut.mp4
Re-running for the same tool reuses its folder and replaces files with the same name.

OAuth: credentials.json (OAuth client, "Desktop app") and the cached token.json
live in the project root; both are gitignored. Only the files listed above are
ever uploaded: auth_*.json, .env, credentials.json and token.json never are.

Run: python -m pipeline.drive_upload gamma [--name "Gamma"] [--num 01] [--out out]
"""

import argparse
import fnmatch
import json
import mimetypes
import os
import re
import sys
from pathlib import Path

from dotenv import load_dotenv
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from googleapiclient.http import MediaFileUpload

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

# Full Drive scope: needed to see the existing "NN - ..." folders (made by people,
# not this app) to pick the next number. drive.file can only see files it created.
SCOPES = ["https://www.googleapis.com/auth/drive"]
CREDENTIALS = ROOT / "credentials.json"
TOKEN = ROOT / "token.json"
FOLDER_MIME = "application/vnd.google-apps.folder"

TOP_FILES = ["script.txt", "shot_list.json", "manifest.json", "summary.md", "rough_cut.mp4"]
CLIP_EXTS = {".mp4", ".png"}
NEVER_UPLOAD = ["auth_*.json", ".env", ".env.*", "credentials*.json", "token*.json", "client_secret*.json"]
NUMBERED = re.compile(r"^(\d+)\s*-\s*(.+)$")


def get_service():
    creds = Credentials.from_authorized_user_file(str(TOKEN), SCOPES) if TOKEN.exists() else None
    if creds and creds.expired and creds.refresh_token:
        creds.refresh(Request())
    elif not creds or not creds.valid:
        if not CREDENTIALS.exists():
            raise RuntimeError(f"{CREDENTIALS.name} not found: download an OAuth client (Desktop app) "
                               "from Google Cloud Console into the project root")
        creds = InstalledAppFlow.from_client_secrets_file(str(CREDENTIALS), SCOPES).run_local_server(port=0)
    TOKEN.write_text(creds.to_json())
    try:
        os.chmod(TOKEN, 0o600)
    except OSError:
        pass
    return build("drive", "v3", credentials=creds, cache_discovery=False)


def _q(s):
    return s.replace("\\", "\\\\").replace("'", "\\'")


def list_children(svc, parent, folders_only=False):
    q = f"'{parent}' in parents and trashed = false"
    if folders_only:
        q += f" and mimeType = '{FOLDER_MIME}'"
    items, token = [], None
    while True:
        r = svc.files().list(q=q, fields="nextPageToken, files(id, name, mimeType)", pageSize=1000,
                             pageToken=token, supportsAllDrives=True, includeItemsFromAllDrives=True).execute()
        items += r.get("files", [])
        token = r.get("nextPageToken")
        if not token:
            return items


def create_folder(svc, name, parent):
    body = {"name": name, "mimeType": FOLDER_MIME, "parents": [parent]}
    return svc.files().create(body=body, fields="id", supportsAllDrives=True).execute()["id"]


def tool_folder(svc, parent, tool_name, num=None):
    """Reuse "NN - <tool_name>" if it exists, else create it.
    NN is `num` if given, otherwise the next free number."""
    taken, same_tool = [], []
    for f in list_children(svc, parent, folders_only=True):
        m = NUMBERED.match(f["name"])
        if not m:
            continue
        taken.append(int(m.group(1)))
        if m.group(2).strip().lower() == tool_name.lower():
            same_tool.append(f)
    if num is None:
        if same_tool:
            return same_tool[0]["id"], same_tool[0]["name"], False
        name = f"{max(taken, default=0) + 1:02d} - {tool_name}"
    else:
        name = f"{str(num).zfill(2)} - {tool_name}"
        for f in same_tool:
            if f["name"].lower() == name.lower():
                return f["id"], f["name"], False
        if same_tool:
            print(f"  note: '{same_tool[0]['name']}' already exists; creating '{name}' as asked")
    return create_folder(svc, name, parent), name, True


def subfolder(svc, parent, name):
    for f in list_children(svc, parent, folders_only=True):
        if f["name"] == name:
            return f["id"]
    return create_folder(svc, name, parent)


def is_forbidden(path):
    return any(fnmatch.fnmatch(path.name.lower(), pat) for pat in NEVER_UPLOAD)


def upload_file(svc, path, parent, existing, name=None):
    name = name or path.name
    if is_forbidden(path) or is_forbidden(Path(name)):  # belt and braces: the allowlist below should never pick these
        raise RuntimeError(f"refusing to upload {path.name}")
    mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    media = MediaFileUpload(str(path), mimetype=mime, resumable=True, chunksize=8 * 1024 * 1024)
    if name in existing:
        req = svc.files().update(fileId=existing[name], media_body=media, supportsAllDrives=True)
    else:
        req = svc.files().create(body={"name": name, "parents": [parent]}, media_body=media,
                                 fields="id", supportsAllDrives=True)
    resp = None
    while resp is None:
        status, resp = req.next_chunk()
        if status and path.stat().st_size > 20 * 1024 * 1024:
            print(f"    {path.name}: {int(status.progress() * 100)}%")
    return resp


def files_to_upload(tool_dir):
    """([(local path, Drive name)], clip files, missing names) from a fixed allowlist."""
    top = {n: tool_dir / n for n in TOP_FILES}
    if not top["shot_list.json"].exists():  # older runs kept it elsewhere; the manifest says where
        try:
            other = json.loads((tool_dir / "manifest.json").read_text(encoding="utf-8")).get("shot_list")
        except (OSError, ValueError):
            other = None
        if other and Path(other).suffix == ".json" and Path(other).exists():
            top["shot_list.json"] = Path(other)
    missing = [n for n, p in top.items() if not p.exists()]
    clips_dir = tool_dir / "clips"
    clips = sorted(p for p in clips_dir.iterdir() if p.is_file() and p.suffix.lower() in CLIP_EXTS) \
        if clips_dir.is_dir() else []
    files = [(p, n) for n, p in top.items() if p.exists() and not is_forbidden(p)]
    return files, [p for p in clips if not is_forbidden(p)], missing


def upload(tool, out_root="out", folder_name=None, num=None, svc=None):
    """Upload the tool's outputs. Returns the Drive folder URL."""
    parent = os.environ.get("DRIVE_FOLDER_ID") or os.environ.get("GOOGLE_DRIVE_PARENT_FOLDER_ID")
    if not parent:
        raise RuntimeError("DRIVE_FOLDER_ID is not set in .env (the AI Tools folder's ID from its URL)")
    tool_dir = Path(out_root) / tool
    if not tool_dir.is_dir():
        raise RuntimeError(f"{tool_dir} not found: run the pipeline for {tool} first")
    top, clips, missing = files_to_upload(tool_dir)
    if not top and not clips:
        raise RuntimeError(f"nothing to upload in {tool_dir}")

    svc = svc or get_service()
    tool_name = folder_name or tool.replace("-", " ").replace("_", " ").title()
    try:
        folder_id, name, created = tool_folder(svc, parent, tool_name, num)
        print(f"> {'created' if created else 'reusing'} folder '{name}'")
        existing = {f["name"]: f["id"] for f in list_children(svc, folder_id)}
        for p, n in top:
            print(f"  uploading {n}")
            upload_file(svc, p, folder_id, existing, n)
        if clips:
            clips_id = subfolder(svc, folder_id, "clips")
            existing_clips = {f["name"]: f["id"] for f in list_children(svc, clips_id)}
            for p in clips:
                print(f"  uploading clips/{p.name}")
                upload_file(svc, p, clips_id, existing_clips)
    except HttpError as e:
        if e.resp.status == 404:
            raise RuntimeError("Drive folder not found: check DRIVE_FOLDER_ID and that this Google "
                               "account can edit the AI Tools folder") from e
        raise RuntimeError(f"Drive API error {e.resp.status}: {e.reason}") from e

    if missing:
        print(f"  not found locally, skipped: {', '.join(missing)}")
    url = f"https://drive.google.com/drive/folders/{folder_id}"
    print(f"Uploaded {len(top)} files + {len(clips)} clips to '{name}'")
    print(f"Folder: {url}")
    return url


def main():
    ap = argparse.ArgumentParser(description="Upload a tool's outputs to the AI Tools Drive folder")
    ap.add_argument("tool")
    ap.add_argument("--name", help='folder display name, e.g. "Pomelli Visual Gen" (default: tool, title-cased)')
    ap.add_argument("--num", help='folder number, e.g. 01 (default: next free number)')
    ap.add_argument("--out", default="out")
    a = ap.parse_args()
    try:
        upload(a.tool, a.out, a.name, a.num)
    except RuntimeError as e:
        sys.exit(str(e))


if __name__ == "__main__":
    main()
