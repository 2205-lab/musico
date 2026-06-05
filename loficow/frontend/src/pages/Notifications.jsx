import { useState, useEffect } from 'react'
import { Bell, Heart, MessageCircle, UserPlus, Send, Users } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { api } from '../utils/api'
import { useAuth } from '../context/AuthContext'
import Avatar from '../components/ui/Avatar'

const TYPE_CONFIG = {
  follow:            { icon: UserPlus,       label: 'followed you',       color: 'text-purple-400', bg: 'bg-purple-500/10' },
  like:              { icon: Heart,          label: 'liked your post',    color: 'text-rose-400',   bg: 'bg-rose-500/10' },
  comment:           { icon: MessageCircle,  label: 'commented on your post', color: 'text-cyan-400', bg: 'bg-cyan-500/10' },
  submission:        { icon: Send,           label: 'sent you a demo',    color: 'text-amber-400',  bg: 'bg-amber-500/10' },
  collab_response:   { icon: Users,          label: 'responded to your collab', color: 'text-green-400', bg: 'bg-green-500/10' },
}

export default function Notifications() {
  const [notifications, setNotifications] = useState([])
  const [loading, setLoading] = useState(true)
  const { user } = useAuth()

  useEffect(() => {
    if (!user) return
    api.get('/notifications')
      .then(d => {
        setNotifications(d.notifications || [])
        api.post('/notifications/read').catch(() => {})
      })
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [user])

  if (!user) return (
    <div className="max-w-xl mx-auto py-24 text-center">
      <Bell className="w-12 h-12 text-slate-700 mx-auto mb-4" />
      <p className="text-slate-500">Sign in to see notifications</p>
    </div>
  )

  return (
    <div className="max-w-xl mx-auto py-8 px-4 pb-24">
      <h1 className="font-display font-bold text-3xl text-slate-100 mb-8">Notifications</h1>

      {loading ? (
        <div className="flex justify-center py-16">
          <div className="w-8 h-8 rounded-full border-2 border-purple-500/30 border-t-purple-500 animate-spin" />
        </div>
      ) : notifications.length === 0 ? (
        <div className="text-center py-24">
          <Bell className="w-12 h-12 text-slate-700 mx-auto mb-4" />
          <p className="text-slate-500">No notifications yet</p>
        </div>
      ) : (
        <div className="space-y-2">
          {notifications.map(n => {
            const config = TYPE_CONFIG[n.type] || TYPE_CONFIG.like
            return (
              <div key={n.id}
                className={`card p-4 flex items-center gap-4 transition-all ${!n.is_read ? 'border-purple-500/20' : ''}`}
              >
                <div className={`w-10 h-10 rounded-xl ${config.bg} flex items-center justify-center flex-shrink-0`}>
                  <config.icon className={`w-5 h-5 ${config.color}`} />
                </div>
                {n.from_avatar || n.from_username ? (
                  <Avatar user={{ avatar_url: n.from_avatar, display_name: n.from_name, username: n.from_username }}
                    size="sm" />
                ) : null}
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-slate-200">
                    <span className="font-medium">{n.from_name || 'Someone'}</span>
                    {' '}{config.label}
                  </p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {formatDistanceToNow(new Date(n.created_at), { addSuffix: true })}
                  </p>
                </div>
                {!n.is_read && <div className="w-2 h-2 rounded-full bg-purple-500 flex-shrink-0" />}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
