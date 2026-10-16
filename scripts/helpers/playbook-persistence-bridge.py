"""Isolated real FastAPI/file persistence for the Node compatibility harness.

JSON-lines transport avoids a listening server, ports, and user library access.
"""
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from fastapi.testclient import TestClient
import backend.api.playbooks as playbooks
from backend.api.app import app

with TemporaryDirectory(prefix="arc-save-simulate-") as directory:
    playbooks.PLAYBOOKS_DIR = Path(directory)
    client = TestClient(app)
    try:
        for line in sys.stdin:
            request = json.loads(line)
            try:
                response = client.request(request["method"], request["path"],
                                          json=request.get("body"), headers=request.get("headers"))
                result = {"id": request["id"], "status": response.status_code,
                          "headers": dict(response.headers), "text": response.text}
            except Exception as error:
                result = {"id": request["id"], "error": f"{type(error).__name__}: {error}"}
            print(json.dumps(result), flush=True)
    finally:
        client.close()
