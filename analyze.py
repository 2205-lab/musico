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

    # Load with multiple fallback strategies to handle any file
    y_stereo = None
    sr = None

    # Strategy 1: load stereo, native sample rate
    try:
        y_stereo, sr = librosa.load(path, sr=None, mono=False)
    except Exception:
        pass

    # Strategy 2: load mono at 22050 (most compatible)
    if y_stereo is None:
        try:
            y_stereo, sr = librosa.load(path, sr=22050, mono=True)
        except Exception:
            pass

    # Strategy 3: try ffmpeg decode via soundfile
    if y_stereo is None:
        try:
            import soundfile as sf
            y_stereo, sr = sf.read(path, always_2d=False)
            y_stereo = y_stereo.T if y_stereo.ndim == 2 else y_stereo
        except Exception:
            pass

    if y_stereo is None:
        raise ValueError("Could not decode audio — unsupported format")

    # Normalise to stereo/mono
    if getattr(y_stereo, 'ndim', 1) == 1 or (hasattr(y_stereo, 'shape') and y_stereo.ndim == 1):
        left = right = y_stereo
        y = y_stereo
        is_stereo = False
    else:
        if y_stereo.shape[0] <= 8:  # channels-first (librosa style)
            left = y_stereo[0]
            right = y_stereo[1] if y_stereo.shape[0] > 1 else y_stereo[0]
        else:  # samples-first (soundfile style)
            left = y_stereo[:, 0]
            right = y_stereo[:, 1] if y_stereo.shape[1] > 1 else y_stereo[:, 0]
        y = (left + right) / 2.0
        is_stereo = True

    if y.size == 0:
        raise ValueError("empty audio")

    # Truncate to max 3 minutes for analysis speed (keeps accuracy)
    max_samples = int(sr * 180)
    if len(y) > max_samples:
        # Use middle section — most representative
        mid = len(y) // 2
        y = y[mid - max_samples//2 : mid + max_samples//2]
        left = left[mid - max_samples//2 : mid + max_samples//2] if is_stereo else y
        right = right[mid - max_samples//2 : mid + max_samples//2] if is_stereo else y

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

    # Spectral balance: energy per frequency band
    S = np.abs(librosa.stft(y)) ** 2
    freqs = librosa.fft_frequencies(sr=sr)
    band_energy = S.sum(axis=1)

    low  = float(band_energy[(freqs >= 20)   & (freqs <  250)].sum())
    mid  = float(band_energy[(freqs >= 250)  & (freqs < 4000)].sum())
    high = float(band_energy[(freqs >= 4000) & (freqs <= 20000)].sum())
    presence = float(band_energy[(freqs >= 2000) & (freqs < 5000)].sum())
    total = low + mid + high + 1e-12

    low_pct  = round(low  / total * 100, 1)
    mid_pct  = round(mid  / total * 100, 1)
    high_pct = round(high / total * 100, 1)
    bass_ratio = int(round(low_pct))
    vocal_clarity = int(max(0, min(100, round((presence / total) * 100 * 3.2))))

    # Stereo width via mid/side
    if is_stereo:
        mid_ch  = (left + right) / 2.0
        side_ch = (left - right) / 2.0
        mid_e  = float(np.mean(mid_ch  ** 2)) + 1e-12
        side_e = float(np.mean(side_ch ** 2))
        stereo_width = int(round(side_e / (mid_e + side_e) * 100))
    else:
        stereo_width = 0

    # LUFS loudness
    lufs = None
    try:
        import pyloudnorm as pyln
        meter = pyln.Meter(sr)
        if is_stereo:
            data = np.vstack([left, right]).T
        else:
            data = y
        lufs_val = float(meter.integrated_loudness(data))
        if lufs_val != float('-inf') and lufs_val == lufs_val:
            lufs = round(lufs_val, 1)
    except Exception:
        pass

    if lufs is None:
        lufs = round(float(20.0 * np.log10(rms + 1e-9)), 1)

    return {
        "energy":           energy,
        "brightness":       brightness,
        "bass_ratio":       bass_ratio,
        "duration":         int(round(duration)),
        "lufs":             lufs,
        "stereo_width":     stereo_width,
        "is_stereo":        bool(is_stereo),
        "low_pct":          low_pct,
        "mid_pct":          mid_pct,
        "high_pct":         high_pct,
        "spectral_centroid": int(round(cent)),
        "vocal_clarity":    vocal_clarity,
    }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "no file path provided"}))
        sys.exit(0)
    try:
        print(json.dumps(analyze(sys.argv[1])))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
