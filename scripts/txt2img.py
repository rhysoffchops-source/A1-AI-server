#!/usr/bin/env python3
"""A1 Text-to-Image — uses SD Turbo for fast generation on M1 GPU (MPS)."""
import sys, time, argparse
import torch
from diffusers import AutoPipelineForText2Image

MODEL = "stabilityai/sd-turbo"

def main():
    parser = argparse.ArgumentParser(description="A1 Text-to-Image")
    parser.add_argument("prompt", help="Text prompt for image generation")
    parser.add_argument("--steps", type=int, default=4, help="Inference steps (1-4 for turbo, default 4)")
    parser.add_argument("--out", default=None, help="Output file path (default: prompt_slug.png)")
    args = parser.parse_args()

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    dtype = torch.float16 if device == "mps" else torch.float32
    print(f"Device: {device}  |  Precision: {dtype}")

    print(f"Loading {MODEL} ...")
    t0 = time.time()
    pipe = AutoPipelineForText2Image.from_pretrained(
        MODEL, torch_dtype=dtype
    )
    pipe.to(device)
    print(f"Loaded in {time.time() - t0:.1f}s")

    print(f"Generating: {args.prompt}")
    t0 = time.time()
    result = pipe(
        prompt=args.prompt,
        num_inference_steps=args.steps,
        guidance_scale=0.0,   # turbo models don't need CFG
        width=512,
        height=512,
    )
    elapsed = time.time() - t0
    print(f"Done in {elapsed:.1f}s")

    out = args.out or (args.prompt[:40].replace(" ", "_").replace("/", "_") + ".png")
    result.images[0].save(out)
    print(f"Saved → {out}")

if __name__ == "__main__":
    main()
