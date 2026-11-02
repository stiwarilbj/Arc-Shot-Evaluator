"""Reproduce the court export outside app/build startup

Requires the native development environment plus onnx
The checkpoint is AGPL-3.0 according to its publisher
No images or benchmark results are downloaded or fabricated here
"""
import argparse, hashlib, json, urllib.request
from pathlib import Path

REVISION = '6cb899251439982067a81baa225b33f45f335981'
URL = f'https://huggingface.co/koppolusameer/yolo11n-basketball-court-keypoints/resolve/{REVISION}/best.pt'

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('workdir', type=Path, help='Private directory outside the public website')
    p.add_argument('--export', action='store_true')
    args = p.parse_args()
    args.workdir.mkdir(parents=True, exist_ok=True)
    checkpoint = args.workdir / 'court.pt'
    if not checkpoint.exists():
        with urllib.request.urlopen(URL) as response, checkpoint.with_suffix('.download').open('wb') as out:
            total = 0
            while chunk := response.read(1024 * 1024):
                total += len(chunk)
                if total > 16 * 1024 * 1024:
                    raise ValueError('Checkpoint exceeds expected download budget')
                out.write(chunk)
        checkpoint.with_suffix('.download').replace(checkpoint)
    record = {'source': URL, 'revision': REVISION, 'checkpointSha256': hashlib.sha256(checkpoint.read_bytes()).hexdigest()}
    if args.export:
        from ultralytics import YOLO
        path = Path(YOLO(checkpoint).export(format='onnx', imgsz=640, opset=17, dynamic=False, simplify=False))
        record.update(onnxSha256=hashlib.sha256(path.read_bytes()).hexdigest(), shape=[1,3,640,640], channels=149, slots=48)
    (args.workdir / 'export.json').write_text(json.dumps(record, indent=2)+'\n')
    print(json.dumps(record, indent=2))

if __name__ == '__main__':
    main()
