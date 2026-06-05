import { useState, useEffect, useRef } from 'react'
import { Send, Hash, Users, Smile } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { api } from '../utils/api'
import { useAuth } from '../context/AuthContext'
import Avatar from '../components/ui/Avatar'
import toast from 'react-hot-toast'

const CATEGORY_COLORS = {
  general:  'text-purple-400',
  feedback: 'text-cyan-400',
  collabs:  'text-green-400',
  releases: 'text-amber-400',
  labels:   'text-rose-400',
  gear:     'text-blue-400',
  misc:     'text-slate-400',
}

export default function Channels() {
  const [channels,  setChannels]  = useState([])
  const [active,    setActive]    = useState(null)
  const [messages,  setMessages]  = useState([])
  const [input,     setInput]     = useState('')
  const [sending,   setSending]   = useState(false)
  const [polling,   setPolling]   = useState(null)
  const messagesEnd = useRef(null)
  const { user } = useAuth()

  useEffect(() => {
    api.get('/channels').then(d => {
      setChannels(d.channels || [])
      if (d.channels?.length) setActive(d.channels[0])
    }).catch(console.error)
  }, [])

  useEffect(() => {
    if (!active) return
    loadMessages(active.id)
    const id = setInterval(() => loadMessages(active.id), 5000)
    setPolling(id)
    return () => clearInterval(id)
  }, [active?.id])

  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function loadMessages(channelId) {
    const data = await api.get(`/channels/${channelId}/messages`).catch(() => ({ messages: [] }))
    setMessages(data.messages || [])
  }

  async function sendMessage(e) {
    e.preventDefault()
    if (!input.trim() || !user || !active) return
    setSending(true)
    try {
      const data = await api.post(`/channels/${active.id}/messages`, { content: input })
      setMessages(m => [...m, data.message])
      setInput('')
    } catch (err) {
      toast.error(err.message)
    } finally {
      setSending(false)
    }
  }

  const grouped = channels.reduce((acc, ch) => {
    if (!acc[ch.category]) acc[ch.category] = []
    acc[ch.category].push(ch)
    return acc
  }, {})

  return (
    <div className="flex h-screen">
      {/* Channel sidebar */}
      <div className="w-56 bg-bg-secondary border-r border-white/5 flex-shrink-0 overflow-y-auto py-4">
        <div className="px-4 mb-4">
          <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Channels</h2>
        </div>
        {Object.entries(grouped).map(([cat, chs]) => (
          <div key={cat} className="mb-4">
            <div className="px-4 py-1 text-xs text-slate-600 uppercase tracking-wider font-medium">{cat}</div>
            {chs.map(ch => (
              <button
                key={ch.id}
                onClick={() => setActive(ch)}
                className={`w-full text-left px-4 py-2 text-sm transition-colors flex items-center gap-2 ${
                  active?.id === ch.id
                    ? 'bg-surface text-slate-100'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-surface/50'
                }`}
              >
                <span className={CATEGORY_COLORS[ch.category]}>{ch.icon}</span>
                <span className="truncate">{ch.name}</span>
              </button>
            ))}
          </div>
        ))}
      </div>

      {/* Chat area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {active ? (
          <>
            {/* Channel header */}
            <div className="px-6 py-4 border-b border-white/5 flex items-center gap-3">
              <span className="text-xl">{active.icon}</span>
              <div>
                <h3 className="font-semibold text-slate-100">#{active.name}</h3>
                <p className="text-xs text-slate-500">{active.description}</p>
              </div>
              <div className="ml-auto flex items-center gap-2 text-xs text-slate-500">
                <Users className="w-3.5 h-3.5" />
                {active.members_count} members
              </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
              {messages.length === 0 ? (
                <div className="text-center py-16">
                  <p className="text-3xl mb-3">{active.icon}</p>
                  <p className="font-semibold text-slate-300 mb-1">Welcome to #{active.name}</p>
                  <p className="text-sm text-slate-500">{active.description}</p>
                </div>
              ) : (
                messages.map((msg, i) => {
                  const showAvatar = i === 0 || messages[i-1].user_id !== msg.user_id
                  return (
                    <div key={msg.id} className={`flex items-start gap-3 ${showAvatar ? 'mt-4' : 'mt-0.5'}`}>
                      {showAvatar
                        ? <Avatar user={msg} size="sm" className="flex-shrink-0 mt-0.5" />
                        : <div className="w-8 flex-shrink-0" />
                      }
                      <div className="min-w-0">
                        {showAvatar && (
                          <div className="flex items-baseline gap-2 mb-0.5">
                            <span className="text-sm font-semibold text-slate-200">{msg.display_name}</span>
                            <span className="text-xs text-slate-600">
                              {formatDistanceToNow(new Date(msg.created_at), { addSuffix: true })}
                            </span>
                          </div>
                        )}
                        <p className="text-sm text-slate-300 leading-relaxed break-words">{msg.content}</p>
                      </div>
                    </div>
                  )
                })
              )}
              <div ref={messagesEnd} />
            </div>

            {/* Input */}
            {user ? (
              <form onSubmit={sendMessage} className="px-6 py-4 border-t border-white/5">
                <div className="flex items-center gap-3 bg-surface rounded-xl px-4 py-3 border border-white/5
                  focus-within:border-purple-500/40 transition-colors">
                  <input
                    value={input}
                    onChange={e => setInput(e.target.value)}
                    placeholder={`Message #${active.name}`}
                    className="flex-1 bg-transparent outline-none text-sm text-slate-100 placeholder-slate-500"
                    maxLength={500}
                  />
                  <button type="submit" disabled={!input.trim() || sending}
                    className="text-purple-400 hover:text-purple-300 disabled:opacity-30 transition-colors">
                    <Send className="w-5 h-5" />
                  </button>
                </div>
              </form>
            ) : (
              <div className="px-6 py-4 border-t border-white/5 text-center text-sm text-slate-500">
                <a href="/auth?mode=login" className="text-purple-400 hover:text-purple-300">Sign in</a> to chat
              </div>
            )}
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <Hash className="w-12 h-12 text-slate-700 mx-auto mb-4" />
              <p className="text-slate-500">Select a channel to start chatting</p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
