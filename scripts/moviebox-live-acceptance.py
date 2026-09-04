"""Prepare or verify the bounded, opt-in live TorBox acceptance test.

This script never reads credentials or contacts a download provider.
"""
import argparse
import hashlib
import json
import re
import uuid
from pathlib import Path
from urllib.request import Request, urlopen

SOURCE = "https://webtorrent.io/torrents/sintel.torrent"
WEBSEED = "https://webtorrent.io/torrents/"


def decode(data):
    offset = 0

    def read():
        nonlocal offset
        token = data[offset:offset + 1]
        if token == b"i":
            offset += 1
            end = data.index(b"e", offset)
            value = int(data[offset:end])
            offset = end + 1
            return value
        if token in (b"d", b"l"):
            offset += 1
            value = {} if token == b"d" else []
            while data[offset:offset + 1] != b"e":
                if token == b"d":
                    key = read()
                    value[key] = read()
                else:
                    value.append(read())
            offset += 1
            return value
        end = data.index(b":", offset)
        size = int(data[offset:end])
        offset = end + 1
        value = data[offset:offset + size]
        offset += size
        return value

    value = read()
    if offset != len(data):
        raise ValueError("Trailing torrent data")
    return value


def encode(value):
    if isinstance(value, int):
        return b"i" + str(value).encode() + b"e"
    if isinstance(value, bytes):
        return str(len(value)).encode() + b":" + value
    if isinstance(value, list):
        return b"l" + b"".join(map(encode, value)) + b"e"
    return b"d" + b"".join(encode(k) + encode(value[k]) for k in sorted(value)) + b"e"


def fetch(url, limit):
    with urlopen(Request(url, headers={"User-Agent": "MoviBox-Acceptance/1"}), timeout=30) as response:
        data = response.read(limit + 1)
    if len(data) > limit:
        raise ValueError("Reference exceeds its byte budget")
    return data


def prepare(root):
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    manifest = root / "manifest.json"
    if manifest.exists():
        print("Prepared run already exists; retained its torrent hash and database.")
        return
    original = fetch(SOURCE, 524288)
    torrent = decode(original)
    info = torrent[b"info"]
    if info[b"name"] != b"Sintel" or torrent[b"url-list"] != [WEBSEED.encode()]:
        raise ValueError("Unexpected public test torrent")
    total = sum(file[b"length"] for file in info[b"files"])
    if not 0 < total < 150_000_000:
        raise ValueError("Test exceeds the 150 MB cloud budget")
    # Keep original files, piece hashes and public webseed paths. A run-specific
    # info dictionary avoids mistaking an already-popular cached torrent for a cache miss.
    info[b"source"] = ("MoviBox acceptance " + str(uuid.uuid4())).encode()
    reference = root / "reference"
    reference.mkdir(exist_ok=True)
    for file in info[b"files"]:
        parts = [part.decode() for part in file[b"path"]]
        if len(parts) != 1 or Path(parts[0]).name != parts[0]:
            raise ValueError("Unexpected reference path")
        if parts[0] == "Sintel.mp4":
            continue
        data = fetch(WEBSEED + "Sintel/" + parts[0], 100_000)
        if len(data) != file[b"length"]:
            raise ValueError("Reference file size changed")
        (reference / parts[0]).write_bytes(data)
    (root / "source.torrent").write_bytes(encode(torrent))
    record = {"fixture": "sintel-webseed-v1", "source": SOURCE,
              "hash": hashlib.sha1(encode(info)).hexdigest(), "cloudBytes": total,
              "videoBytes": next(f[b"length"] for f in info[b"files"] if f[b"path"] == [b"Sintel.mp4"]),
              "mediaId": "tt1727587", "title": "Sintel", "license": "Creative Commons Attribution 3.0",
              "limits": "One torrent, below 150 MB; one French subtitle; no cloud deletions."}
    manifest.write_text(json.dumps(record, indent=2) + "\n")
    print(json.dumps(record, indent=2))


def cues(path):
    content = path.read_text(encoding="utf-8-sig").replace("\r\n", "\n")
    found = []
    for block in re.split(r"\n\s*\n", content.strip()):
        lines = block.splitlines()
        for index, line in enumerate(lines):
            if " --> " in line:
                found.append((line.strip(), " ".join(lines[index + 1:]).strip()))
                break
    return found


def verify(root):
    torrent = decode((root / "source.torrent").read_bytes())
    info = torrent[b"info"]
    expected = info[b"pieces"]
    piece_size = info[b"piece length"]
    pending = bytearray()
    actual = bytearray()
    video_digest = hashlib.sha256()
    for file in info[b"files"]:
        name = file[b"path"][0].decode()
        path = root / "Sintel.mp4" if name == "Sintel.mp4" else root / "reference" / name
        if path.stat().st_size != file[b"length"]:
            raise ValueError("Downloaded size differs from the source torrent")
        with path.open("rb") as source:
            while block := source.read(1024 * 1024):
                if name == "Sintel.mp4":
                    video_digest.update(block)
                pending.extend(block)
                while len(pending) >= piece_size:
                    actual.extend(hashlib.sha1(pending[:piece_size]).digest())
                    del pending[:piece_size]
    if pending:
        actual.extend(hashlib.sha1(pending).digest())
    integrity = actual == expected
    subtitle = root / "Sintel.fr.srt"
    reference_cues = cues(root / "reference" / "Sintel.fr.srt")
    downloaded_cues = cues(subtitle) if subtitle.exists() else []
    def timestamps(cue):
        return [int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000
                for h, m, s, ms in re.findall(r"(\d{2}):(\d{2}):(\d{2})[,\.](\d{3})", cue[0])]
    offsets = [round(actual - expected, 3)
               for reference, downloaded in zip(reference_cues, downloaded_cues)
               for expected, actual in zip(timestamps(reference), timestamps(downloaded))]
    comparable = bool(reference_cues) and len(reference_cues) == len(downloaded_cues) and len(offsets) == 2 * len(reference_cues)
    result = {"torrentPieceIntegrity": integrity, "videoSha256": video_digest.hexdigest(),
              "frenchSubtitlePresent": bool(downloaded_cues),
              "frenchCuesMatchPublishedReference": bool(reference_cues) and downloaded_cues == reference_cues,
              "referenceCueCount": len(reference_cues), "downloadedCueCount": len(downloaded_cues),
              "cueTimingMatchesReference": comparable and all(offset == 0 for offset in offsets),
              "uniformCueOffsetSeconds": offsets[0] if comparable and len(set(offsets)) == 1 else None,
              "playbackReviewed": False,
              "note": "Different subtitles require playback review; file existence alone is not language or timing proof."}
    (root / "file-verification.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))
    if not integrity:
        raise SystemExit("Torrent piece verification failed")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["prepare", "verify"])
    parser.add_argument("root", type=Path)
    args = parser.parse_args()
    if not args.root.is_absolute():
        parser.error("Use an absolute, dedicated test directory")
    (prepare if args.action == "prepare" else verify)(args.root)
