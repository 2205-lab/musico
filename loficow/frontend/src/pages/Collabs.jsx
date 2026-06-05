import { useState, useEffect } from 'react'
import { Plus, Users, Music2, X } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { api } from '../utils/api'
import { useAuth } from '../context/AuthContext'
import Avatar from '../components/ui/Avatar'
import toast from 'react-hot-toast'

function CollabCard({ collab }) {
  const tags  = collab.tags?.split(',').filter(Boolean) || []
  const roles = collab.looking_for?.split(',').filter(Boolean) || []

  return (
    <div className="card card-hover p-5">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-3">
          <Avatar user={collab} size="sm" />
          <div>
            <span className="text-sm font-semibold text-slate-100">{collab.display_name}</span>
            <p className="text-xs text-slate-500">@{collab.username}</p>
          </div>
        </div>
        <span className="text-xs text-slate-600">
          {formatDistanceToNow(new Date(collab.created_at), { addSuffix: true })}
        </span>
      </div>
      <h3 className="font-semibold text-slate-100 mb-2">{collab.title}</h3>
      <p className="text-sm text-slate-400 leading-relaxed mb-3">{collab.description}</p>
      <div className="flex flex-wrap gap-2 mb-4">
        {roles.map(r => <span key={r} className="badge-green">{r.trim()}</span>)}
        {tags.map(t => <span key={t} className="text-xs text-purple-400">#{t.trim()}</span>)}
      </div>
      <div className="flex items-center justify-between pt-3 border-t border-white/5">
        <span className="text-xs text-slate-500">{collab.responses_count} responses</span>
        <button className="btn-primary text-xs py-1.5 px-4">Respond</button>
      </div>
    </div>
  )
}

function CreateCollabModal({ onClose, onCreated }) {
  const [form, setForm] = useState({ title:'', description:'', looking_for:'', tags:'' })
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setLoading(true)
    try {
      const data = await api.post('/collabs', {
        ...form,
        looking_for: form.looking_for.split(',').map(s=>s.trim()).filter(Boolean),
        tags: form.tags.split(',').map(s=>s.trim()).filter(Boolean),
      })
      onCreated(data.collab)
      toast.success('Collab post created!')
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
          <h2 className="font-display font-bold text-xl text-slate-100">Find Collaborators</h2>
          <button onClick={onClose} className="btn-ghost p-1"><X className="w-5 h-5" /></button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs text-slate-400 mb-1.5">Title</label>
            <input {...field('title')} placeholder="e.g. Looking for jazz pianist for lofi EP"
              className="input" required />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1.5">Description</label>
            <textarea {...field('description')} placeholder="Describe your project and what you're working on..."
              rows={4} className="input resize-none" required />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1.5">Looking for (comma separated)</label>
            <input {...field('looking_for')} placeholder="Vocalist, Pianist, Guitarist" className="input" required />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1.5">Tags</label>
            <input {...field('tags')} placeholder="lofi, jazz, chill" className="input" />
          </div>
          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose} className="btn-secondary flex-1">Cancel</button>
            <button type="submit" disabled={loading} className="btn-primary flex-1">
              {loading ? 'Posting...' : 'Post Collab'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default function Collabs() {
  const [collabs,    setCollabs]    = useState([])
  const [showCreate, setShowCreate] = useState(false)
  const [loading,    setLoading]    = useState(true)
  const { user } = useAuth()

  useEffect(() => {
    api.get('/collabs').then(d => setCollabs(d.collabs || [])).finally(() => setLoading(false))
  }, [])

  return (
    <div className="max-w-2xl mx-auto py-8 px-4 pb-24">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="font-display font-bold text-3xl text-slate-100">Collabs</h1>
          <p className="text-slate-500 mt-1">Find your next creative partner</p>
        </div>
        {user && (
          <button onClick={() => setShowCreate(true)} className="btn-primary flex items-center gap-2">
            <Plus className="w-4 h-4" /> Post Collab
          </button>
        )}
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <div className="w-8 h-8 rounded-full border-2 border-purple-500/30 border-t-purple-500 animate-spin" />
        </div>
      ) : collabs.length === 0 ? (
        <div className="text-center py-24">
          <Users className="w-12 h-12 text-slate-700 mx-auto mb-4" />
          <p className="text-slate-500">No collab posts yet. Be the first!</p>
        </div>
      ) : (
        <div className="space-y-4">
          {collabs.map(c => <CollabCard key={c.id} collab={c} />)}
        </div>
      )}

      {showCreate && (
        <CreateCollabModal
          onClose={() => setShowCreate(false)}
          onCreated={c => setCollabs(p => [c, ...p])}
        />
      )}
    </div>
  )
}
