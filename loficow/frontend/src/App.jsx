import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { useAuth } from './context/AuthContext'
import Sidebar from './components/layout/Sidebar'
import MusicPlayer from './components/layout/MusicPlayer'
import Landing from './pages/Landing'
import Auth from './pages/Auth'
import Feed from './pages/Feed'
import Channels from './pages/Channels'
import Profile from './pages/Profile'
import Marketplace from './pages/Marketplace'
import Explore from './pages/Explore'
import Collabs from './pages/Collabs'
import Submissions from './pages/Submissions'
import Notifications from './pages/Notifications'

function ProtectedRoute({ children }) {
  const { user, loading } = useAuth()
  const location = useLocation()
  if (loading) return (
    <div className="flex items-center justify-center h-screen">
      <div className="w-10 h-10 rounded-full border-2 border-purple-500/30 border-t-purple-500 animate-spin" />
    </div>
  )
  if (!user) return <Navigate to={`/auth?mode=login&next=${location.pathname}`} replace />
  return children
}

function AppLayout({ children }) {
  return (
    <div className="flex">
      <Sidebar />
      <main className="ml-64 flex-1 min-h-screen">
        {children}
      </main>
      <MusicPlayer />
    </div>
  )
}

export default function App() {
  const { user, loading } = useAuth()

  if (loading) return (
    <div className="flex items-center justify-center h-screen bg-bg-primary">
      <div className="text-center">
        <div className="w-10 h-10 rounded-full border-2 border-purple-500/30 border-t-purple-500 animate-spin mx-auto mb-4" />
        <p className="text-slate-500 text-sm">Loading LofiCow...</p>
      </div>
    </div>
  )

  return (
    <Routes>
      <Route path="/" element={user ? <Navigate to="/feed" replace /> : <Landing />} />
      <Route path="/auth" element={user ? <Navigate to="/feed" replace /> : <Auth />} />

      <Route path="/feed" element={
        <ProtectedRoute>
          <AppLayout><Feed /></AppLayout>
        </ProtectedRoute>
      } />
      <Route path="/explore" element={
        <ProtectedRoute>
          <AppLayout><Explore /></AppLayout>
        </ProtectedRoute>
      } />
      <Route path="/channels" element={
        <ProtectedRoute>
          <AppLayout><Channels /></AppLayout>
        </ProtectedRoute>
      } />
      <Route path="/beats" element={
        <ProtectedRoute>
          <AppLayout><Marketplace /></AppLayout>
        </ProtectedRoute>
      } />
      <Route path="/collabs" element={
        <ProtectedRoute>
          <AppLayout><Collabs /></AppLayout>
        </ProtectedRoute>
      } />
      <Route path="/submissions" element={
        <ProtectedRoute>
          <AppLayout><Submissions /></AppLayout>
        </ProtectedRoute>
      } />
      <Route path="/notifications" element={
        <ProtectedRoute>
          <AppLayout><Notifications /></AppLayout>
        </ProtectedRoute>
      } />
      <Route path="/profile/:username" element={
        <ProtectedRoute>
          <AppLayout><Profile /></AppLayout>
        </ProtectedRoute>
      } />

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
