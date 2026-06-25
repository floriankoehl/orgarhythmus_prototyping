import { useState } from 'react'
import { authApi } from '../api'
import styles from './AuthPage.module.css'

export default function AuthPage({ onAuthenticated }) {
  const [mode, setMode] = useState('login')
  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const isRegister = mode === 'register'

  const submit = async (event) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      if (isRegister) {
        await authApi.register({ email, displayName, password })
      } else {
        await authApi.login({ email, password })
      }
      const user = await authApi.me()
      onAuthenticated(user)
    } catch (err) {
      setError(err.message || 'Authentication failed')
    } finally {
      setBusy(false)
    }
  }

  const switchMode = (nextMode) => {
    setMode(nextMode)
    setError('')
  }

  return (
    <div className={styles.page}>
      <main className={styles.panel}>
        <div className={styles.header}>
          <div className={styles.mark}>O</div>
          <div>
            <h1>Orgarhythmus</h1>
            <p>{isRegister ? 'Create your workspace account.' : 'Sign in to your projects.'}</p>
          </div>
        </div>

        <div className={styles.tabs} role="tablist" aria-label="Authentication mode">
          <button
            type="button"
            className={`${styles.tab} ${!isRegister ? styles.tabActive : ''}`}
            onClick={() => switchMode('login')}
          >
            Login
          </button>
          <button
            type="button"
            className={`${styles.tab} ${isRegister ? styles.tabActive : ''}`}
            onClick={() => switchMode('register')}
          >
            Register
          </button>
        </div>

        <form className={styles.form} onSubmit={submit}>
          <label className={styles.field}>
            <span>{isRegister ? 'Email' : 'Email or username'}</span>
            <input
              type={isRegister ? 'email' : 'text'}
              autoComplete={isRegister ? 'email' : 'username'}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </label>

          {isRegister && (
            <label className={styles.field}>
              <span>Display name</span>
              <input
                type="text"
                autoComplete="name"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                required
              />
            </label>
          )}

          <label className={styles.field}>
            <span>Password</span>
            <input
              type="password"
              autoComplete={isRegister ? 'new-password' : 'current-password'}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              minLength={8}
              required
            />
          </label>

          {error && <div className={styles.error}>{error}</div>}

          <button className={styles.submit} type="submit" disabled={busy}>
            {busy ? 'Working...' : isRegister ? 'Create account' : 'Login'}
          </button>
        </form>
      </main>
    </div>
  )
}
