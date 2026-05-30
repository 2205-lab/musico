import sys
import json

def analyze_audio(file_path):
    try:
        import librosa
        import numpy as np
        
        # Load only first 30 seconds to avoid timeout
        y, sr = librosa.load(file_path, duration=30, mono=True)
        
        if len(y) == 0:
            print(json.dumps({'error': 'Empty audio file'}))
            return

        # BPM
        tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
        bpm = int(round(float(tempo)))

        # Key
        chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
        chroma_mean = np.mean(chroma, axis=1)
        key_names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B']
        key_index = int(np.argmax(chroma_mean))
        key = key_names[key_index]

        # Major/Minor
        major_profile = np.array([6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88])
        minor_profile = np.array([6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17])
        major_corr = float(np.corrcoef(chroma_mean, major_profile)[0,1])
        minor_corr = float(np.corrcoef(chroma_mean, minor_profile)[0,1])
        mode = 'Major' if major_corr > minor_corr else 'Minor'

        # Energy
        rms = librosa.feature.rms(y=y)
        energy_val = float(np.mean(rms))
        energy_percent = min(100, max(0, int(energy_val * 2000)))

        # Brightness
        centroid = librosa.feature.spectral_centroid(y=y, sr=sr)
        centroid_mean = float(np.mean(centroid))
        if centroid_mean < 1500:
            brightness = 'Dark (heavy low end)'
        elif centroid_mean < 3000:
            brightness = 'Balanced'
        else:
            brightness = 'Bright (strong high end)'

        # Bass ratio
        stft = np.abs(librosa.stft(y))
        freqs = librosa.fft_frequencies(sr=sr)
        bass_mask = freqs < 250
        bass_energy = float(np.mean(stft[bass_mask]))
        total_energy = float(np.mean(stft)) + 1e-10
        bass_ratio = min(100, int((bass_energy / total_energy) * 100))

        # Duration
        duration = int(librosa.get_duration(y=y, sr=sr))

        result = {
            'bpm': bpm,
            'key': f'{key} {mode}',
            'energy': energy_percent,
            'brightness': brightness,
            'bass_ratio': bass_ratio,
            'danceability': min(100, int(bpm / 2)),
            'duration': duration
        }

        print(json.dumps(result))

    except Exception as e:
        print(json.dumps({'error': str(e)}))
        sys.exit(1)

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps({'error': 'No file path provided'}))
    else:
        analyze_audio(sys.argv[1])
