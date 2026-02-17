import os
import tempfile
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse
import torch
import whisper

def _env_dump() -> dict:
    return {
        "WHISPER_MODEL": os.getenv("WHISPER_MODEL", "base"),
        "WHISPER_DEVICE": os.getenv("WHISPER_DEVICE", "auto"),
        "HIP_VISIBLE_DEVICES": os.getenv("HIP_VISIBLE_DEVICES"),
        "ROCR_VISIBLE_DEVICES": os.getenv("ROCR_VISIBLE_DEVICES"),
    }

app = FastAPI()

MODEL_NAME = os.getenv("WHISPER_MODEL", "base")
DEVICE_SETTING = os.getenv("WHISPER_DEVICE", "auto")

_model = None


def _resolve_device() -> str:
    if DEVICE_SETTING == "cpu":
        return "cpu"
    if DEVICE_SETTING == "cuda":
        return "cuda"
    return "cuda" if torch.cuda.is_available() else "cpu"


@app.on_event("startup")
def load_model() -> None:
    global _model
    device = _resolve_device()
    try:
        _model = whisper.load_model(MODEL_NAME, device=device)
    except Exception as exc:
        print("Failed to load model", exc, _env_dump(), flush=True)
        raise


@app.get("/")
def health():
    device = _resolve_device()
    return {
        "status": "running",
        "model_status": "loaded" if _model is not None else "loading",
        "model_name": MODEL_NAME,
        "device": device,
        "cuda_available": torch.cuda.is_available(),
        "env": _env_dump(),
    }


@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...), language: str | None = Form(None)):
    if _model is None:
        return JSONResponse(status_code=503, content={"detail": "model not loaded"})

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=True) as tmp:
        tmp.write(await file.read())
        tmp.flush()
        options = {"fp16": torch.cuda.is_available()}
        if language:
            options["language"] = language
        result = _model.transcribe(tmp.name, **options)

    return {"text": (result.get("text") or "").strip()}
