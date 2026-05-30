import sys
import json
import librosa
import numpy as np

def analyze_audio(file_path):
    try:
        # Load audio file
        y, sr = librosa.load(file_path, duration=60)
        
        # BPM detection
        tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
        bpm = round(float(tempo))
        
        # Key detection
        chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
        chroma_mean = np.mean(chroma, axis=1)
        key_names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B']
        key_index = int(np.argmax(chroma_mean))
        key = key_names[key_index]
        
        # Major or Minor detection
        major_profile = np.array([6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88])
        minor_profile = np.array([6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17])
        
        major_corr = np.corrcoef(chroma_mean, major_profile)[0,1]
        minor_corr = np.corrcoef(chroma_mean, minor_profile)[0,1]
        mode = 'Major' if major_corr > minor_corr else 'Minor'
        
        # Energy level
        rms = librosa.feature.rms(y=y)
        energy = round(float(np.mean(rms)) * 1000, 2)
        energy_percent = min(100, round(energy * 10))
        
        # Frequency analysis
        spectral_centroid = librosa.feature.spectral_centroid(y=y, sr=sr)
        centroid_mean = float(np.mean(spectral_centroid))
        
        if centroid_mean < 1500:
            brightness = 'Dark (heavy low end)'
        elif centroid_mean < 3000:
            brightness = 'Balanced'
        else:
            brightness = 'Bright (strong high end)'
        
        # Bass presence
        stft = np.abs(librosa.stft(y))
        freqs = librosa.fft_frequencies(sr=sr)
        bass_mask = freqs < 250
        bass_energy = float(np.mean(stft[bass_mask]))
        total_energy = float(np.mean(stft))
        bass_ratio = round((bass_energy / total_energy) * 100)
        
        # Danceability estimate
        onset_env = librosa.onset.onset_strength(y=y, sr=sr)
        pulse = librosa.beat.plp(onset_envelope=onset_env, sr=sr)
        danceability = min(100, round(float(np.mean(pulse)) * 200))
        
        # Duration
        duration = round(librosa.get_duration(y=y, sr=sr))
        
        result = {
            'bpm': bpm,
            'key': f'{key} {mode}',
            'energy': energy_percent,
            'brightness': brightness,
            'bass_ratio': bass_ratio,
            'danceability': danceability,
            'duration': duration,
            'centroid': round(centroid_mean)
        }
        
        print(json.dumps(result))
        
    except Exception as e:
        print(json.dumps({'error': str(e)}))

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps({'error': 'No file path provided'}))
    else:
        analyze_audio(sys.argv[1])
