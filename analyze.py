#!/usr/bin/env python3
"""
Wavmind deep audio analyzer.
Outputs JSON with producer-grade metrics:
  energy, brightness, bass_ratio, duration   (kept for backward compatibility)
  lufs               integrated loudness (LUFS) - real if pyloudnorm available, else approx
  stereo_width       0-100 (side energy vs total)
  is_stereo          true/false
  low_pct/mid_pct/high_pct   spectral balance (% of energy per band)
  spectral_centroid  brightness in Hz
  vocal_clarity      0-100 proxy (presence band 2-5kHz)
Usage: python3 analyze.py "/path/to/file.mp3"
"""
import sys
import json


def analyze(path):
    import numpy as np
    import librosa

    # Try to load with channels preserved (for stereo width). Fall back to resampled.
    try:
        y_stereo, sr = librosa.load(path, sr=None, mono=False)
    except Exception:
        y_stereo, sr = librosa.load(path, sr=22050, mono=False)

    if getattr(y_stereo, "ndim", 1) == 1:
        left = right = y_stereo
        y = y_stereo
        is_stereo = False
    else:
        left = y_stereo[0]
        right = y_stereo[1] if y_stereo.shape[0] > 1 else y_stereo[0]
        y = np.mean(y_stereo, axis=0)
        is_stereo = y_stereo.shape[0] > 1

    if y.size == 0:
        raise ValueError("empty audio")

    duration = float(len(y) / sr)

    # --- RMS energy -> 0-100 ---
    rms = float(np.sqrt(np.mean(y ** 2)))
    energy = int(max(0, min(100, round(rms * 320))))

    # --- Spectral centroid -> brightness ---
    cent = float(np.mean(librosa.feature.spectral_centroid(y=y, sr=sr)))
    if cent < 1800:
        brightness = "Dark (heavy low end)"
    elif cent < 3500:
        brightness = "Balanced"
    else:
        brightness = "Bright (strong high end)"

    # --- Spectral balance: energy per frequency band ---
    S = np.abs(librosa.stft(y)) ** 2
    freqs = librosa.fft_frequencies(sr=sr)
    band_energy = S.sum(axis=1)  # energy per frequency bin

    low = float(band_energy[(freqs >= 20) & (freqs < 250)].sum())
    mid = float(band_energy[(freqs >= 250) & (freqs < 4000)].sum())
    high = float(band_energy[(freqs >= 4000) & (freqs <= 20000)].sum())
    presence = float(band_energy[(freqs >= 2000) & (freqs < 5000)].sum())
    total = low + mid + high + 1e-12

    low_pct = round(low / total * 100, 1)
    mid_pct = round(mid / total * 100, 1)
    high_pct = round(high / total * 100, 1)
    bass_ratio = int(round(low_pct))  # backward-compat field

    # vocal clarity proxy: presence band share, scaled to a friendly 0-100
    vocal_clarity = int(max(0, min(100, round((presence / total) * 100 * 3.2))))

    # --- Stereo width via mid/side ---
    if is_stereo:
        mid_ch = (left + right) / 2.0
        side_ch = (left - right) / 2.0
        mid_e = float(np.mean(mid_ch ** 2)) + 1e-12
        side_e = float(np.mean(side_ch ** 2))
        width = side_e / (mid_e + side_e)
        stereo_width = int(round(width * 100))
    else:
        stereo_width = 0

    # --- Loudness (LUFS) ---
    lufs = None
    try:
        import pyloudnorm as pyln
        meter = pyln.Meter(sr)
        if is_stereo:
            data = np.vstack([left, right]).T  # samples x channels
        else:
            data = y
        lufs = float(meter.integrated_loudness(data))
        if lufs == float("-inf") or lufs != lufs:  # -inf or NaN
            raise ValueError("invalid lufs")
    except Exception:
        # Approximate loudness from RMS dBFS (not true LUFS, but a usable proxy)
        lufs = float(round(20.0 * np.log10(rms + 1e-9), 1))

    return {
        "energy": energy,
        "brightness": brightness,
        "bass_ratio": bass_ratio,
        "duration": int(round(duration)),
        "lufs": round(float(lufs), 1),
        "stereo_width": stereo_width,
        "is_stereo": bool(is_stereo),
        "low_pct": low_pct,
        "mid_pct": mid_pct,
        "high_pct": high_pct,
        "spectral_centroid": int(round(cent)),
        "vocal_clarity": vocal_clarity,
    }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "no file path provided"}))
        sys.exit(0)
    try:
        print(json.dumps(analyze(sys.argv[1])))
    except Exception as e:
        print(json.dumps({"error": str(e)}))

