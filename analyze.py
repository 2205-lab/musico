#!/usr/bin/env python3
"""
Wavmind deep audio analyzer — handles any audio format, any size.
Outputs JSON with: energy, brightness, bass_ratio, duration,
lufs, stereo_width, is_stereo, low_pct, mid_pct, high_pct,
spectral_centroid, vocal_clarity
"""
import sys
import json


def analyze(path):
    import numpy as np
    import librosa

    y_stereo = None
    sr = None

    try:
        y_stereo, sr = librosa.load(path, sr=None, mono=False)
    except Exception:
        pass

    if y_stereo is None:
        try:
            y_stereo, sr = librosa.load(path, sr=22050, mono=True)
        except Exception:
            pass

    if y_stereo is None:
        try:
            import soundfile as sf
            y_stereo, sr = sf.read(path, always_2d=False)
            y_stereo = y_stereo.T if y_stereo.ndim == 2 else y_stereo
        except Exception:
            pass

    if y_stereo is None:
        raise ValueError("Could not decode audio")

    if getattr(y_stereo, 'ndim', 1) == 1 or (hasattr(y_stereo, 'shape') and y_stereo.ndim == 1):
        left = right = y_stereo
        y = y_stereo
        is_stereo = False
    else:
        if y_stereo.shape[0] <= 8:
            left = y_stereo[0]
            right = y_stereo[1] if y_stereo.shape[0] > 1 else y_stereo[0]
        else:
            left = y_stereo[:, 0]
            right = y_stereo[:, 1] if y_stereo.shape[1] > 1 else y_stereo[:, 0]
        y = (left + right) / 2.0
        is_stereo = True

    if y.size == 0:
        raise ValueError("empty audio")

    max_samples = int(sr * 180)
    if len(y) > max_samples:
        mid = len(y) // 2
        half = max_samples // 2
        y     = y[mid - half : mid + half]
        left  = left[mid - half : mid + half]  if is_stereo else y
        right = right[mid - half : mid + half] if is_stereo else y

    duration = float(len(y) / sr)

    # RMS energy → 0-100
    rms = float(np.sqrt(np.mean(y ** 2)))
    energy = int(max(0, min(100, round(rms * 320))))

    # Spectral centroid → brightness label
    cent = float(np.mean(librosa.feature.spectral_centroid(y=y, sr=sr)))
    if cent < 1800:
        brightness = "Dark (heavy low end)"
    elif cent < 3500:
        brightness = "Balanced"
    else:
        brightness = "Bright (strong high end)"

    # Spectral balance — use power spectrum summed per band
    S = np.abs(librosa.stft(y)) ** 2
    freqs = librosa.fft_frequencies(sr=sr)
    band_energy = S.sum(axis=1)

    # Only count audible range 20Hz-20kHz for percentages
    audible_mask = (freqs >= 20) & (freqs <= 20000)
    audible_total = float(band_energy[audible_mask].sum()) + 1e-12

    low_mask      = (freqs >= 20)   & (freqs <  250)
    mid_mask      = (freqs >= 250)  & (freqs < 4000)
    high_mask     = (freqs >= 4000) & (freqs <= 20000)
    # Vocal presence band: 1kHz-5kHz (wider, more accurate for vocals)
    presence_mask = (freqs >= 1000) & (freqs < 5000)

    low_e      = float(band_energy[low_mask].sum())
    mid_e      = float(band_energy[mid_mask].sum())
    high_e     = float(band_energy[high_mask].sum())
    presence_e = float(band_energy[presence_mask].sum())

    low_pct  = round(low_e  / audible_total * 100, 1)
    mid_pct  = round(mid_e  / audible_total * 100, 1)
    high_pct = round(high_e / audible_total * 100, 1)
    bass_ratio = int(round(low_pct))

    # Vocal clarity: presence band (1-5kHz) relative to mid band (250-4kHz)
    # A high ratio means vocals cut through the mix clearly
    # Scale: 0.25 ratio = 0%, 0.80 ratio = 100%
    mid_total = float(band_energy[mid_mask].sum()) + 1e-12
    presence_ratio = presence_e / mid_total
    vocal_clarity = int(max(0, min(100, round((presence_ratio - 0.25) / 0.55 * 100))))

    # Stereo width
    if is_stereo:
        mid_ch  = (left + right) / 2.0
        side_ch = (left - right) / 2.0
        mid_e_ch  = float(np.mean(mid_ch  ** 2)) + 1e-12
        side_e_ch = float(np.mean(side_ch ** 2))
        stereo_width = int(round(side_e_ch / (mid_e_ch + side_e_ch) * 100))
    else:
        stereo_width = 0

    # LUFS
    lufs = None
    try:
        import pyloudnorm as pyln
        meter = pyln.Meter(sr)
        data = np.vstack([left, right]).T if is_stereo else y
        lufs_val = float(meter.integrated_loudness(data))
        if lufs_val != float('-inf') and lufs_val == lufs_val:
            lufs = round(lufs_val, 1)
    except Exception:
        pass
    if lufs is None:
        lufs = round(float(20.0 * np.log10(rms + 1e-9)), 1)

    return {
        "energy":            energy,
        "brightness":        brightness,
        "bass_ratio":        bass_ratio,
        "duration":          int(round(duration)),
        "lufs":              lufs,
        "stereo_width":      stereo_width,
        "is_stereo":         bool(is_stereo),
        "low_pct":           low_pct,
        "mid_pct":           mid_pct,
        "high_pct":          high_pct,
        "spectral_centroid": int(round(cent)),
        "vocal_clarity":     vocal_clarity,
    }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "no file path provided"}))
        sys.exit(0)
    try:
        print(json.dumps(analyze(sys.argv[1])))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
