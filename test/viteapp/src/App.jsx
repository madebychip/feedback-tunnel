function PlanCard({ name, price }) {
  return (<div style={{padding: 20, border: '1px solid #ddd', borderRadius: 10, width: 200}}>
    <h3>{name}</h3><p>{price}</p><button>Choose {name}</button></div>)
}
export default function App() {
  return (<main style={{fontFamily: 'system-ui', padding: 40}}>
    <h1>Pricing</h1>
    <section style={{display: 'flex', gap: 16}}>
      <PlanCard name="Solo" price="$12" /><PlanCard name="Pair" price="$20" /><PlanCard name="Office" price="$60" />
    </section></main>)
}
