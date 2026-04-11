"""Lightweight embedding server using sentence-transformers + FastAPI."""
import os
import torch
from fastapi import FastAPI
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer

MODEL_ID = os.getenv("EMBED_MODEL", "mixedbread-ai/mxbai-embed-large-v1")
DEVICE = "cuda:0" if torch.cuda.is_available() else "cpu"

print(f"Loading {MODEL_ID} on {DEVICE} (visible GPUs: {os.getenv('CUDA_VISIBLE_DEVICES', 'all')})...")
model = SentenceTransformer(MODEL_ID, device=DEVICE)
print(f"Ready! Embedding dim: {model.get_sentence_embedding_dimension()}")

app = FastAPI()

class EmbedRequest(BaseModel):
    inputs: str | list[str]
    truncate: bool = True

@app.post("/embed")
def embed(req: EmbedRequest):
    texts = [req.inputs] if isinstance(req.inputs, str) else req.inputs
    vecs = model.encode(texts, normalize_embeddings=True).tolist()
    return vecs
