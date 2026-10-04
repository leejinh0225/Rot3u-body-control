"""Download pinned browser dependencies; no camera images are uploaded."""
from pathlib import Path
import hashlib, io, json, tarfile, urllib.request

ROOT = Path(__file__).resolve().parent
ASSETS = ROOT / 'vendor'
ASSETS.mkdir(exist_ok=True)
manifest = []

def download(url):
    with urllib.request.urlopen(url, timeout=90) as response:
        return response.read()

def save(name, data, source):
    target = ASSETS / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    manifest.append(dict(file=name, bytes=len(data), sha256=hashlib.sha256(data).hexdigest(), source=source))

for package, version, wanted in [
    ('@mediapipe/tasks-vision', '0.10.32', ['vision_bundle.mjs', 'wasm/', 'README.md']),
    ('three', '0.180.0', ['build/three.module.js', 'build/three.core.js', 'LICENSE']),
]:
    meta = json.loads(download(f'https://registry.npmjs.org/{package}/{version}'))
    url = meta['dist']['tarball']
    data = download(url)
    if hashlib.sha1(data).hexdigest() != meta['dist']['shasum']:
        raise RuntimeError(f'Package digest mismatch: {package}')
    prefix = 'mediapipe/' if package.startswith('@') else 'three/'
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        for member in archive.getmembers():
            if not member.isfile() or not member.name.startswith('package/'):
                continue
            rel = member.name[len('package/'):]
            if any(rel == part or (part.endswith('/') and rel.startswith(part)) for part in wanted):
                save(prefix + rel, archive.extractfile(member).read(), url)
model = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task'
save('pose_landmarker_lite.task', download(model), model)
save('mediapipe/LICENSE', download('https://raw.githubusercontent.com/google-ai-edge/mediapipe/master/LICENSE'), 'https://github.com/google-ai-edge/mediapipe/blob/master/LICENSE')
(ROOT / 'assets-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
print(f'Prepared {len(manifest)} local assets ({sum(x["bytes"] for x in manifest):,} bytes)')
