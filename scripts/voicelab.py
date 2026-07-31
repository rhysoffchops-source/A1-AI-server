#!/usr/bin/env python3
"""A1 Voice Lab — text-to-speech using Bark (Suno, open-source, runs locally)."""
import sys, argparse, time, os
from pathlib import Path

def main():
    parser = argparse.ArgumentParser(description="A1 Voice Lab")
    parser.add_argument("prompt", help="Text to speak, or path to .txt file")
    parser.add_argument("--voice", default=None, help="Voice preset (speaker prompt file or short description)")
    parser.add_argument("--out", default=None, help="Output .wav path")
    args = parser.parse_args()

    # If prompt is a file, read it
    prompt = args.prompt
    if os.path.isfile(prompt):
        prompt = Path(prompt).read_text().strip()
    if not prompt:
        print("Error: empty prompt", file=sys.stderr)
        sys.exit(1)

    print("Loading Bark (first run downloads ~4GB of models)...")
    t0 = time.time()

    from bark import SAMPLE_RATE, generate_audio, preload_models
    from scipy.io.wavfile import write as write_wav

    preload_models()
    print(f"Models loaded in {time.time() - t0:.1f}s")

    # Voice preset
    voice_preset = None
    if args.voice:
        vp = args.voice
        if os.path.isfile(vp):
            voice_preset = Path(vp).read_text().strip()
        else:
            voice_preset = vp

    print(f"Generating: {prompt[:100]}...")
    t0 = time.time()
    audio_array = generate_audio(prompt, history_prompt=voice_preset)
    elapsed = time.time() - t0
    print(f"Done in {elapsed:.1f}s ({len(audio_array) / SAMPLE_RATE:.1f}s audio)")

    out = args.out or (prompt[:30].replace(" ", "_").replace("/", "_") + ".wav")
    write_wav(out, SAMPLE_RATE, audio_array)
    print(f"Saved → {out}")

if __name__ == "__main__":
    main()
