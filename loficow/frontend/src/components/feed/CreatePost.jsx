import { useState, useRef } from 'react'
import { Music2, Image, X, Tag, ChevronDown } from 'lucide-react'
import { useAuth } from '../../context/AuthContext'
import Avatar from '../ui/Avatar'
import { api } from '../../utils/api'
import toast from 'react-hot-toast'

const POST_TYPES = [
  { value: 'track',          label: '🎵 Track Release' },
  { value: 'wip',            label: '🔧 WIP' },
  { value: 'thought',        label: '💭 Thought' },
  { value: 'collab_request', label: '🤝 Collab Request' },
]

export default function CreatePost({ onCreated }) {
  const { user } = useAuth()
  const [content,   setContent]   = useState('')
  const [postType,  setPostType]  = useState('thought')
  const [trackTitle,setTrackTitle]= useState('')
  const [bpm,       setBpm]       = useState('')
  const [key,       setKey]       = useState('')
  const [tags,      setTags]      = useState('')
  const [audioFile, setAudioFile] = useState(null)
  const [coverFile, setCoverFile] = useState(null)
  const [coverPreview, setCoverPreview] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [expanded,  setExpanded]  = useState(false)
  const audioRef = useRef()
  const coverRef = useRef()

  function handleCover(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setCoverFile(file)
    setCoverPreview(URL.createObjectURL(file))
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (!content.trim() && !audioFile) { toast.error('Add some content or audio'); return }
    setSubmitting(true)
    try {
      let audioUrl = null, coverUrl = null
      if (audioFile) {
        const fd = new FormData(); fd.append('audio', audioFile)
        const res = await api.upload('/uploads/audio', fd)
        audioUrl = res.url
      }
      if (coverFile) {
        const fd = new FormData(); fd.append('image', coverFile)
        const res = await api.upload('/uploads/image?type=cover', fd)
        coverUrl = res.url
      }
      const data = await api.post('/posts', {
        content, post_type: postType, audio_url: audioUrl, cover_url: coverUrl,
        track_title: trackTitle || null, track_bpm: bpm || null,
        track_key: key || null, tags: tags || null,
      })
      onCreated?.(data.post)
      toast.success('Posted!')
      setContent(''); setTrackTitle(''); setBpm(''); setKey(''); setTags('')
      setAudioFile(null); setCoverFile(null); setCoverPreview(null)
      setExpanded(false); setPostType('thought')
    } catch (err) {
      toast.error(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="card p-4">
      <div className="flex gap-3">
        <Avatar user={user} size="sm" />
        <div className="flex-1">
          <textarea
            value={content}
            onChange={e => { setContent(e.target.value); if (!expanded && e.target.value) setExpanded(true) }}
            onFocus={() => setExpanded(true)}
            placeholder="Share a beat, a thought, or find a collab partner..."
            rows={expanded ? 3 : 1}
            className="input resize-none text-sm transition-all"
          />

          {expanded && (
            <div className="mt-3 space-y-3 animate-slide-up">
              {/* Type selector */}
              <div className="flex gap-2 flex-wrap">
                {POST_TYPES.map(t => (
                  <button
                    key={t.value}
                    type="button"
                    onClick={() => setPostType(t.value)}
                    className={`text-xs px-3 py-1.5 rounded-lg border transition-all ${
                      postType === t.value
                        ? 'border-purple-500 bg-purple-500/15 text-purple-300'
                        : 'border-white/10 text-slate-400 hover:border-white/20'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              {/* Track metadata */}
              {(postType === 'track' || postType === 'wip') && (
                <div className="grid grid-cols-3 gap-2">
                  <input value={trackTitle} onChange={e=>setTrackTitle(e.target.value)}
                    placeholder="Track title" className="input text-xs py-2 col-span-3" />
                  <input value={bpm} onChange={e=>setBpm(e.target.value)} placeholder="BPM"
                    type="number" className="input text-xs py-2" />
                  <input value={key} onChange={e=>setKey(e.target.value)} placeholder="Key (e.g. C minor)"
                    className="input text-xs py-2 col-span-2" />
                </div>
              )}

              <input value={tags} onChange={e=>setTags(e.target.value)}
                placeholder="Tags: lofi, jazz, chill (comma separated)"
                className="input text-xs py-2" />

              {/* Audio & cover previews */}
              {audioFile && (
                <div className="flex items-center gap-2 bg-purple-500/10 border border-purple-500/20 rounded-lg px-3 py-2">
                  <Music2 className="w-4 h-4 text-purple-400" />
                  <span className="text-xs text-purple-300 truncate">{audioFile.name}</span>
                  <button onClick={() => setAudioFile(null)} className="ml-auto">
                    <X className="w-3 h-3 text-slate-400" />
                  </button>
                </div>
              )}
              {coverPreview && (
                <div className="relative w-20 h-20">
                  <img src={coverPreview} alt="" className="w-full h-full object-cover rounded-lg" />
                  <button onClick={() => { setCoverFile(null); setCoverPreview(null) }}
                    className="absolute -top-1 -right-1 w-5 h-5 bg-bg-primary rounded-full flex items-center justify-center">
                    <X className="w-3 h-3 text-slate-300" />
                  </button>
                </div>
              )}

              {/* Action row */}
              <div className="flex items-center justify-between pt-1">
                <div className="flex gap-1">
                  <input ref={audioRef} type="file" accept="audio/*" className="hidden" onChange={e => setAudioFile(e.target.files?.[0] || null)} />
                  <input ref={coverRef} type="file" accept="image/*" className="hidden" onChange={handleCover} />
                  <button type="button" onClick={() => audioRef.current?.click()}
                    className="btn-ghost flex items-center gap-1 text-xs">
                    <Music2 className="w-4 h-4" /> Audio
                  </button>
                  <button type="button" onClick={() => coverRef.current?.click()}
                    className="btn-ghost flex items-center gap-1 text-xs">
                    <Image className="w-4 h-4" /> Cover
                  </button>
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setExpanded(false)} className="btn-secondary text-sm py-2 px-4">
                    Cancel
                  </button>
                  <button onClick={handleSubmit} disabled={submitting} className="btn-primary text-sm py-2 px-4">
                    {submitting ? 'Posting...' : 'Post'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
