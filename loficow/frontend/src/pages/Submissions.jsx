import { useState, useEffect } from 'react'
import { Send, CheckCircle, XCircle, Clock, Plus, X, Search } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { api } from '../utils/api'
import { useAuth } from '../context/AuthContext'
import Avatar from '../components/ui/Avatar'
import toast from 'react-hot-toast'

const STATUS_CONFIG = {
  pending:  { icon: Clock,       label: 'Pending',  class: 'badge-amber' },
  reviewed: { icon: Clock,       label: 'Reviewed', class: 'badge-cyan' },
  accepted: { icon: CheckCircle, label: 'Accepted', class: 'badge-green' },
  declined: { icon: XCircle,     label: 'Declined', class: 'bg-rose-500/15 text-rose-300 border border-rose-500/20 badge' },
}

function SubmitModal({ onClose, onCreated }) {
  const [labels,  setLabels]  = useState([])
  const [search,  setSearch]  = useState('')
  const [form,    setForm]    = useState({ label_id:'', track_title:'', audio_url:'', cover_url:'', message:'' })
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    api.get('/explore', { q: search, type: 'artists' })
      .then(d => setLabels((d.artists || []).filter(a => ['label','both'].includes(a.account_type))))
  }, [search])

  async function handleSubmit(e) {
    e.preventDefault()
    setLoading(true)
    try {
      await api.post('/submissions', { ...form, label_id: parseInt(form.label_id) })
      toast.success('Demo submitted!')
      onCreated()
      onClose()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setLoading(false)
    }
  }

  function field(key) {
    return { value: form[key], onChange: e => setForm(f => ({ ...f, [key]: e.target.value })) }
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="card w-full max-w-lg p-6 animate-slide-up">
        <div className="flex items-center justify-between mb-6">
          <h2 className="font-display font-bold text-xl text-slate-100">Submit Demo</h2>
          <button onClick={onClose} className="btn-ghost p-1"><X className="w-5 h-5" /></button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs text-slate-400 mb-1.5">Search Label</label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
              <input value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Search for a label..." className="input pl-9 text-sm" />
            </div>
            {labels.length > 0 && (
              <div className="mt-1 glass rounded-xl max-h-36 overflow-y-auto">
                {labels.map(l => (
                  <button key={l.id} type="button"
                    onClick={() => { setForm(f => ({ ...f, label_id: l.id })); setSearch(l.display_name) }}
                    className="w-full flex items-center gap-3 px-3 py-2 hover:bg-surface transition-colors text-left">
                    <Avatar user={l} size="xs" />
                    <span className="text-sm text-slate-200">{l.display_name}</span>
                    <span className="badge-cyan ml-auto">label</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1.5">Track Title</label>
            <input {...field('track_title')} placeholder="Your track name" className="input" required />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1.5">Audio URL (SoundCloud, Google Drive, etc.)</label>
            <input {...field('audio_url')} type="url" placeholder="https://..." className="input" required />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1.5">Message to Label (optional)</label>
            <textarea {...field('message')} placeholder="Tell them about your track..." rows={3}
              className="input resize-none" />
          </div>
          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose} className="btn-secondary flex-1">Cancel</button>
            <button type="submit" disabled={loading || !form.label_id} className="btn-primary flex-1">
              {loading ? 'Submitting...' : 'Send Demo'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default function Submissions() {
  const [submissions, setSubmissions] = useState([])
  const [role,        setRole]        = useState('artist')
  const [showModal,   setShowModal]   = useState(false)
  const [loading,     setLoading]     = useState(true)
  const { user } = useAuth()

  function load() {
    if (!user) return
    setLoading(true)
    api.get('/submissions', { role })
      .then(d => setSubmissions(d.submissions || []))
      .catch(console.error)
      .finally(() => setLoading(false))
  }

  useEffect(load, [role, user])

  if (!user) return (
    <div className="max-w-2xl mx-auto py-24 text-center">
      <Send className="w-12 h-12 text-slate-700 mx-auto mb-4" />
      <p className="text-slate-400">Sign in to manage demo submissions</p>
    </div>
  )

  const canSeeLabel = ['label','both'].includes(user.account_type)

  return (
    <div className="max-w-3xl mx-auto py-8 px-4 pb-24">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="font-display font-bold text-3xl text-slate-100">Submissions</h1>
          <p className="text-slate-500 mt-1">Track your demo submissions</p>
        </div>
        <button onClick={() => setShowModal(true)} className="btn-primary flex items-center gap-2">
          <Plus className="w-4 h-4" /> Submit Demo
        </button>
      </div>

      {/* Role tabs */}
      {canSeeLabel && (
        <div className="flex gap-1 mb-6 border-b border-white/5">
          {['artist','label'].map(r => (
            <button key={r} onClick={() => setRole(r)}
              className={`px-4 py-2.5 text-sm font-medium capitalize border-b-2 -mb-px transition-colors ${
                role === r ? 'border-purple-500 text-purple-300' : 'border-transparent text-slate-500 hover:text-slate-300'
              }`}
            >
              {r === 'artist' ? 'My Submissions' : 'Received (Label)'}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-16">
          <div className="w-8 h-8 rounded-full border-2 border-purple-500/30 border-t-purple-500 animate-spin" />
        </div>
      ) : submissions.length === 0 ? (
        <div className="text-center py-24">
          <Send className="w-12 h-12 text-slate-700 mx-auto mb-4" />
          <p className="text-slate-500">No submissions yet</p>
        </div>
      ) : (
        <div className="space-y-3">
          {submissions.map(s => {
            const status = STATUS_CONFIG[s.status] || STATUS_CONFIG.pending
            return (
              <div key={s.id} className="card p-4 flex items-center gap-4">
                <div className="w-12 h-12 rounded-xl bg-surface flex items-center justify-center flex-shrink-0">
                  <Send className="w-5 h-5 text-purple-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-slate-100 truncate">{s.track_title}</p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {role === 'artist'
                      ? `To: ${s.label_name || s.label_username}`
                      : `From: ${s.artist_name || s.artist_username}`}
                    {' · '}
                    {formatDistanceToNow(new Date(s.created_at), { addSuffix: true })}
                  </p>
                </div>
                <span className={status.class}>{status.label}</span>
              </div>
            )
          })}
        </div>
      )}

      {showModal && (
        <SubmitModal onClose={() => setShowModal(false)} onCreated={load} />
      )}
    </div>
  )
}
