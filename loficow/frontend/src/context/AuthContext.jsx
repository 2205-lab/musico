import { createContext, useContext, useState, useEffect } from 'react'
import { api } from '../utils/api'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser]       = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const token = localStorage.getItem('loficow_token')
    if (token) {
      api.get('/auth/me')
        .then(d => setUser(d.user))
        .catch(() => localStorage.removeItem('loficow_token'))
        .finally(() => setLoading(false))
    } else {
      setLoading(false)
    }
  }, [])

  async function login(credentials) {
    const data = await api.post('/auth/login', credentials)
    localStorage.setItem('loficow_token', data.token)
    setUser(data.user)
    return data.user
  }

  async function register(fields) {
    const data = await api.post('/auth/register', fields)
    localStorage.setItem('loficow_token', data.token)
    setUser(data.user)
    return data.user
  }

  async function logout() {
    await api.post('/auth/logout').catch(() => {})
    localStorage.removeItem('loficow_token')
    setUser(null)
  }

  function updateUser(updates) {
    setUser(prev => ({ ...prev, ...updates }))
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout, updateUser }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
