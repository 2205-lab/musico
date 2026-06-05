export default function WaveformBars({ playing = false, color = 'bg-purple-400', bars = 5 }) {
  return (
    <div className="flex items-center gap-0.5 h-4">
      {Array.from({ length: bars }).map((_, i) => (
        <div
          key={i}
          className={`w-0.5 rounded-full ${color} ${playing ? 'waveform-bar' : ''}`}
          style={{
            height: playing ? '100%' : `${30 + (i % 3) * 25}%`,
            animationDelay: `${i * 0.1}s`,
            transition: 'height 0.3s ease',
          }}
        />
      ))}
    </div>
  )
}
