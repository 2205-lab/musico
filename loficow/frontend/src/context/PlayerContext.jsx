import { createContext, useContext, useState, useRef, useCallback } from 'react'

const PlayerContext = createContext(null)

export function PlayerProvider({ children }) {
  const [track, setTrack]         = useState(null)
  const [playing, setPlaying]     = useState(false)
  const [progress, setProgress]   = useState(0)
  const [duration, setDuration]   = useState(0)
  const [volume, setVolume]       = useState(0.8)
  const audioRef = useRef(new Audio())

  const audio = audioRef.current

  audio.volume = volume
  audio.onended   = () => setPlaying(false)
  audio.ontimeupdate = () => setProgress(audio.currentTime)
  audio.ondurationchange = () => setDuration(audio.duration || 0)

  const play = useCallback((newTrack) => {
    if (track?.audio_url === newTrack.audio_url) {
      if (playing) { audio.pause(); setPlaying(false) }
      else         { audio.play(); setPlaying(true) }
      return
    }
    audio.src = newTrack.audio_url
    audio.load()
    audio.play().then(() => setPlaying(true)).catch(console.error)
    setTrack(newTrack)
    setProgress(0)
  }, [track, playing])

  const pause  = () => { audio.pause();  setPlaying(false) }
  const resume = () => { audio.play();   setPlaying(true)  }
  const seek   = (t) => { audio.currentTime = t }
  const changeVolume = (v) => { setVolume(v); audio.volume = v }

  return (
    <PlayerContext.Provider value={{ track, playing, progress, duration, volume, play, pause, resume, seek, changeVolume }}>
      {children}
    </PlayerContext.Provider>
  )
}

export function usePlayer() {
  return useContext(PlayerContext)
}
