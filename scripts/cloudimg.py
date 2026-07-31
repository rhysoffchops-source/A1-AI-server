#!/usr/bin/env python3
"""A1 Cloud Text-to-Image — uses Replicate API. No local GPU needed. Free tier.

Setup (one time):
  1. Sign up at https://replicate.com/signin (GitHub login is easiest)
  2. Get your token at https://replicate.com/account/api-tokens
  3. export REPLICATE_API_TOKEN="r8_your_token_here"
"""

import os, sys, time, argparse
from pathlib import Path

MODELS = {
    "flux-schnell": "black-forest-labs/flux-schnell",
    "flux-dev":     "black-forest-labs/flux-dev",
    "sdxl":         "stability-ai/sdxl:39ed52f2a78e934b3ba6e2a89f5b1c712de7dfea535525255b1aa35c5565e08b",
    "sd3":          "stability-ai/stable-diffusion-3",
}

def main():
    parser = argparse.ArgumentParser(description="A1 Cloud Text-to-Image (Replicate)")
    parser.add_argument("prompt", help="Image description")
    parser.add_argument("--model", choices=list(MODELS.keys()), default="flux-schnell",
                        help="Model (default: flux-schnell)")
    parser.add_argument("--negative", default="", help="Negative prompt")
    parser.add_argument("--out", default=None, help="Output file")
    parser.add_argument("--width", type=int, default=1024, help="Width (default: 1024)")
    parser.add_argument("--height", type=int, default=1024, help="Height (default: 1024)")
    parser.add_argument("--steps", type=int, default=28, help="Steps (default: 28)")
    parser.add_argument("--seed", type=int, default=None, help="Random seed")
    parser.add_argument("--list", action="store_true", help="List models")
    args = parser.parse_args()

    if args.list:
        for name, model_id in MODELS.items():
            print(f"  {name:14s} → {model_id}")
        return

    token = os.environ.get("REPLICATE_API_TOKEN", "")
    if not token:
        print("Error: REPLICATE_API_TOKEN not set.", file=sys.stderr)
        print("  1. Sign up at https://replicate.com/signin", file=sys.stderr)
        print("  2. Get token at https://replicate.com/account/api-tokens", file=sys.stderr)
        print("  3. export REPLICATE_API_TOKEN='r8_your_token'", file=sys.stderr)
        sys.exit(1)

    import replicate

    model_ref = MODELS[args.model]
    print(f"Model:  {model_ref}")
    print(f"Prompt: {args.prompt[:120]}")
    print("Generating via Replicate cloud GPU (free tier)...")

    input_kwargs: dict = {
        "prompt": args.prompt,
        "width": args.width,
        "height": args.height,
        "num_inference_steps": args.steps,
    }
    if args.negative:
        input_kwargs["negative_prompt"] = args.negative
    if args.seed is not None:
        input_kwargs["seed"] = args.seed

    # flux-schnell doesn't support negative_prompt or num_inference_steps
    if args.model == "flux-schnell":
        input_kwargs.pop("num_inference_steps", None)
        input_kwargs.pop("negative_prompt", None)
        input_kwargs["num_outputs"] = 1
        input_kwargs["aspect_ratio"] = "1:1"

    t0 = time.time()
    try:
        output = replicate.run(model_ref, input=input_kwargs)
    except Exception as e:
        msg = str(e)
        if "401" in msg or "Unauthorized" in msg:
            print("Error: Invalid or expired API token.", file=sys.stderr)
            print("Get a new one at https://replicate.com/account/api-tokens", file=sys.stderr)
        elif "402" in msg or "quota" in msg.lower():
            print("Error: Free tier quota exceeded. Wait or add payment method.", file=sys.stderr)
        else:
            print(f"Error: {msg}", file=sys.stderr)
        sys.exit(1)

    elapsed = time.time() - t0

    # output is either a list of FileOutput/URLs or a single URL string
    url = None
    if isinstance(output, list) and len(output) > 0:
        url = str(output[0])
    elif isinstance(output, str):
        url = output

    if not url:
        print(f"Unexpected response: {output}", file=sys.stderr)
        sys.exit(1)

    out = args.out or (args.prompt[:40].replace(" ", "_").replace("/", "_") + ".png")
    import urllib.request
    data = urllib.request.urlopen(url).read()
    Path(out).write_bytes(data)
    size_kb = len(data) / 1024
    print(f"Done in {elapsed:.1f}s — {size_kb:.0f} KB")
    print(f"Saved → {out}")

if __name__ == "__main__":
    main()
