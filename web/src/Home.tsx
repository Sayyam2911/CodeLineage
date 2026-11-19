import { useEffect, useState } from 'react'
import { ArrowRight, AudioLines, BookOpen, Code2, GitCommitHorizontal, GitFork, Github } from 'lucide-react'
import type { Mode } from './api'

let introHasEntered = false

export function Home({ onSelect }: { onSelect: (mode: Mode) => void }) {
  const [enter] = useState(() => !introHasEntered)
  useEffect(() => { introHasEntered = true }, [])

  return <main className={'home' + (enter ? ' home-enter' : '')} aria-labelledby="home-title">
    <div className="home-grid">
      <div className="intro">
        <h1 id="home-title"><span>Architecture decisions</span><em>with their evidence.</em></h1>
        <p>Review a GitHub repository, record why the code works the way it does, and give the next developer the exact source.</p>
        <div className="home-choices">
          <button className="home-action home-action-primary" onClick={() => onSelect('update')}>
            <GitFork size={17}/><span>Create or update code lineage</span><ArrowRight size={18}/>
          </button>
          <button className="home-action home-action-secondary" onClick={() => onSelect('understand')}>
            <BookOpen size={17}/><span>Understand code lineage</span><ArrowRight size={18}/>
          </button>
        </div>
      </div>
      <section className="example-workspace" aria-label="Healthchecks review example">
        <header className="example-title">
          <div><Github size={16}/><strong>Healthchecks</strong><span className="example-divider"/><span>Alert delivery</span></div>
          <span className="example-commit"><GitCommitHorizontal size={14}/> 51a5035</span>
        </header>
        <div className="example-panels">
          <div className="example-map">
            <div className="example-label"><GitFork size={14}/> Architecture</div>
            <div className="example-nodes">
              <div className="example-node"><span/>Check changes status</div>
              <div className="example-track"/>
              <div className="example-node"><span/>Select eligible channels</div>
              <div className="example-track"/>
              <div className="example-node active"><span/>Order by delivery time</div>
            </div>
          </div>
          <div className="example-source">
            <div className="example-label"><Code2 size={15}/> Source evidence</div>
            <div className="example-file">hc/api/models.py</div>
            <div className="example-lines" aria-label="Healthchecks source lines 1407 to 1409">
              <div><i>1407</i><code>q = <wbr/>self.owner.channel_set.<wbr/>exclude(disabled=<em>True</em>)</code></div>
              <div className="example-line-focus"><i>1408</i><code>q = q.order_by(F(<wbr/><b>"last_notify_duration"</b>).<wbr/>asc(nulls_last=<em>True</em>))</code></div>
              <div><i>1409</i><code><em>return</em> [ch <em>for</em> ch <em>in</em> q <em>if not</em> <wbr/>ch.transport.<wbr/>is_noop(self.new_status)]</code></div>
            </div>
          </div>
        </div>
        <footer className="example-question">
          <div className="example-voice"><AudioLines size={20}/></div>
          <div><span>Interview question</span><p>What should happen when a channel has no delivery history?</p></div>
        </footer>
      </section>
    </div>
  </main>
}
