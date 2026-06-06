import { NavLink, useNavigate } from 'react-router-dom'
import {
  Home, Compass, Hash, Music2, Mic2, Users, Send,
  Bell, Settings, LogOut, Plus, Moon
} from 'lucide-react'
import { useAuth } from '../../context/AuthContext'
import Avatar from '../ui/Avatar'
import toast from 'react-hot-toast'

const navItems = [
  { to: '/feed',        icon: Home,    label: 'Feed' },
  { to: '/explore',     icon: Compass, label: 'Explore' },
  { to: '/channels',    icon: Hash,    label: 'Channels' },
  { to: '/beats',       icon: Music2,  label: 'Beat Market' },
  { to: '/collabs',     icon: Users,   label: 'Collabs' },
  { to: '/submissions', icon: Send,    label: 'Submissions' },
]

export default function Sidebar() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()

  async function handleLogout() {
    await logout()
    toast.success('See you around 🌙')
    navigate('/')
  }

  return (
    <aside className="fixed left-0 top-0 h-screen w-64 glass-strong border-r border-white/5
      flex flex-col z-40">
      {/* Logo */}
      <div className="p-6 pb-4">
        <NavLink to="/feed" className="flex items-center gap-3 group">
          <div className="w-9 h-9 rounded-xl bg-gradient-brand flex items-center justify-center
            shadow-glow-purple group-hover:scale-105 transition-transform">
            <Moon className="w-5 h-5 text-white" />
          </div>
          <span className="font-display font-bold text-xl gradient-text">LofiCow</span>
        </NavLink>
      </div>

      {/* Create post */}
      <div className="px-4 pb-4">
        <button
          onClick={() => navigate('/feed?create=1')}
          className="w-full btn-primary flex items-center justify-center gap-2 text-sm"
        >
          <Plus className="w-4 h-4" />
          New Post
        </button>
      </div>

      <div className="divider mx-4" />

      {/* Navigation */}
      <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
        {navItems.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `nav-link ${isActive ? 'active' : ''}`
            }
          >
            <Icon className="w-4 h-4 flex-shrink-0" />
            {label}
          </NavLink>
        ))}
      </nav>

      <div className="divider mx-4" />

      {/* User section */}
      <div className="p-4 space-y-2">
        <NavLink to="/notifications" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
          <Bell className="w-4 h-4" />
          Notifications
        </NavLink>
        <NavLink to="/settings" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
          <Settings className="w-4 h-4" />
          Settings
        </NavLink>

        <div className="divider my-2" />

        <NavLink
          to={`/profile/${user?.username}`}
          className="flex items-center gap-3 p-2 rounded-xl hover:bg-surface transition-colors group"
        >
          <Avatar user={user} size="sm" showVerified />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-slate-200 truncate">{user?.display_name}</p>
            <p className="text-xs text-slate-500 truncate">@{user?.username}</p>
          </div>
        </NavLink>

        <button
          onClick={handleLogout}
          className="w-full nav-link text-rose-400 hover:text-rose-300 hover:bg-rose-500/10"
        >
          <LogOut className="w-4 h-4" />
          Sign Out
        </button>
      </div>
    </aside>
  )
}
