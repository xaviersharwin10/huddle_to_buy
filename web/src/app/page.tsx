"use client";

import { useState, useEffect } from "react";
import confetti from "canvas-confetti";
import { CheckCircle2, Play, Activity, Network, Zap, Bot, Cpu, Wifi, MessageSquare } from "lucide-react";
import "./globals.css";

const AGENTS = [
  { id: "buyer1", name: "Buyer 1", port: 3001, type: "buyer" },
  { id: "buyer2", name: "Buyer 2", port: 3002, type: "buyer" },
  { id: "buyer3", name: "Buyer 3", port: 3003, type: "buyer" },
  { id: "seller", name: "Seller Agent", port: 3004, type: "seller" }
];

function Agent3DScene({ gState }: any) {
  const [rotate, setRotate] = useState({ x: 10, y: -10 });

  const handleMouseMove = (e: any) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width - 0.5;
    const y = (e.clientY - rect.top) / rect.height - 0.5;
    setRotate({ x: y * -20, y: x * 20 });
  };

  const isIdle = gState === "idle";
  const isTransmitting = gState === "broadcasting" || gState === "revealing";
  const isNegotiating = gState === "negotiated";
  const isDeploying = gState === "deploying" || gState === "settled";
  const isDone = gState === "paid";

  const getThought = (botId: string) => {
    if (isIdle) return null;
    if (isTransmitting) {
      // Broadcasting phase: buyers have committed intents, waiting for k=3 threshold
      if (botId === 'b1') return "commit broadcast on AXL mesh…";
      if (botId === 'b2') return "scanning for matching intents…";
      if (botId === 'b3') return "k=3 threshold not yet reached";
      if (botId === 'seller') return "listening on huddle GossipSub…";
    }
    if (isNegotiating) {
      // Coordinator (b1) sends negotiate_request / X402 quote, offer received
      if (botId === 'b1') return "paying X402 quote fee → seller";
      if (botId === 'b2') return "reveal_response sent ✓";
      if (botId === 'b3') return "cluster formed! awaiting offer…";
      if (botId === 'seller') return "X402 verified → tier price set";
    }
    if (isDeploying) {
      // Coalition deployed, buyers fund escrow
      if (botId === 'b1') return "Coalition.sol deployed, funding…";
      if (botId === 'b2') return "coalition_ready → approve+fund";
      if (botId === 'b3') return "coalition_ready → approve+fund";
      if (botId === 'seller') return "waiting for KeeperHub commit()";
    }
    if (isDone) {
      // All buyers funded, keeper calls commit()
      if (botId === 'b1') return "escrow funded ✓ keeper pending";
      if (botId === 'b2') return "MockUSDC escrowed ✓";
      if (botId === 'b3') return "MockUSDC escrowed ✓";
      if (botId === 'seller') return "payout secured via Coalition.sol";
    }
    return null;
  };

  const RobotNode = ({ id, label, x, y, scale = 1, flip = false, hue = 0, thought, highlight, isFailed = false }: any) => {
    const isLoner = id === 'b1';
    const hasThought = !!thought;
    return (
      <div style={{
        position: 'absolute', left: x, top: y,
        transform: `scale(${scale}) translateZ(${40 * scale}px)`,
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        transition: 'all 0.8s ease-out', pointerEvents: 'none', zIndex: id==='b2' ? 5 : 2,
        opacity: isFailed ? 0.3 : 1
      }}>
        <div style={{
           opacity: hasThought ? 1 : 0, transform: hasThought ? 'translateY(0)' : 'translateY(10px)',
           transition: 'all 0.3s', background: isFailed ? 'rgba(50,0,0,0.9)' : 'rgba(5,5,15,0.85)', 
           color: isFailed ? '#ff4444' : '#06b6d4',
           padding: '8px 12px', borderRadius: isFailed ? '2px' : '12px', fontSize: '0.75rem', fontWeight: 'bold',
           marginBottom: '10px', position: 'relative', whiteSpace: 'nowrap',
           boxShadow: `0 4px 15px ${isFailed ? 'rgba(255,0,0,0.5)' : highlight}`, zIndex: 10,
           border: `1px solid ${isFailed ? '#ff0000' : highlight}`,
           backdropFilter: 'blur(5px)'
        }}>
           {thought}
           <div style={{ position: 'absolute', bottom: '-5px', left: '50%', transform: 'translateX(-50%)', borderTop: `5px solid ${isFailed ? '#ff0000' : 'rgba(5,5,15,0.85)'}`, borderLeft: '5px solid transparent', borderRight: '5px solid transparent' }}></div>
        </div>
        
        <img src="https://raw.githubusercontent.com/microsoft/fluentui-emoji/main/assets/Robot/3D/robot_3d.png" 
             alt={label} 
             style={{ 
               width: '100px', height: '100px', objectFit: 'contain', 
               transform: flip ? 'scaleX(-1)' : 'none', 
               filter: `brightness(${isFailed ? 0.1 : 0.4}) contrast(1.5) drop-shadow(0 15px 15px rgba(0,0,0,0.8)) ${!isFailed ? `drop-shadow(0 0 25px ${highlight})` : ''} hue-rotate(${hue}deg)` 
             }} />
        <div style={{ marginTop: '8px', background: 'rgba(0,0,0,0.6)', padding: '4px 8px', borderRadius: '4px', fontSize: '0.65rem', fontWeight: 'bold', color: '#fff', border: `1px solid ${highlight}` }}>{label}</div>
      </div>
    );
  };

  return (
    <div className="glass-panel" 
         onMouseMove={handleMouseMove}
         onMouseLeave={() => setRotate({x: 10, y: -10})}
         style={{ 
           position: 'relative', height: '420px', display: 'flex', alignItems: 'center', justifyContent: 'center', 
           overflow: 'hidden', marginBottom: '2rem', background: '#020205',
           perspective: '1200px', cursor: 'grab', border: '1px solid rgba(6,182,212,0.2)'
         }}>
         
      <div style={{
         position: 'absolute', width: '100%', height: '100%',
         transform: `rotateX(${rotate.x + 10}deg) rotateY(${rotate.y}deg)`,
         transformStyle: 'preserve-3d', transition: 'transform 0.1s linear'
      }}>
        {/* Floor grid */}
        <div style={{
          position: 'absolute', top: '70%', left: '-50%', width: '200%', height: '200%',
          background: 'linear-gradient(transparent 49%, rgba(6, 182, 212, 0.15) 50%, transparent 51%), linear-gradient(90deg, transparent 49%, rgba(168, 85, 247, 0.1) 50%, transparent 51%)',
          backgroundSize: '80px 80px', transform: 'rotateX(80deg)', transformOrigin: 'top center'
        }}></div>

        {/* Global HUD Scanner Bar */}
        <div style={{ 
          position: 'absolute', top: '5%', left: '50%', transform: 'translateX(-50%) translateZ(-50px)', 
          textAlign: 'center', zIndex: 1, pointerEvents: 'none',
          background: 'rgba(0,0,0,0.6)', border: '1px solid rgba(255,255,255,0.2)', padding: '0.5rem 2rem', 
          width: '400px', borderRadius: '4px', overflow: 'hidden' 
        }}>
          <div style={{ position: 'relative', fontSize: '1rem', fontWeight: 800, color: '#fff', textTransform: 'uppercase', letterSpacing: '3px', textShadow: '0 0 10px rgba(255,255,255,0.8)' }}>
            {isIdle ? "Agents on Standby" : 
             isTransmitting ? "0G Storage Retrieval" :
             isNegotiating ? "AXL P2P Mesh Forming" :
             isDeploying ? "KEEPERHUB SETTLEMENT CHECK..." :
             isDone ? "Settlement Guaranteed. Save to 0G." : "Processing..."}
          </div>
          {(isTransmitting || isNegotiating || isDeploying) && (
             <div style={{ position: 'absolute', left: 0, top: 0, width: '15px', height: '100%', background: '#06b6d4', opacity: 0.8, boxShadow: '0 0 20px #06b6d4', animation: 'scan 2s cubic-bezier(0.4, 0, 0.2, 1) infinite' }} />
          )}
        </div>

        {/* AXL P2P Fiber Optic Mesh connecting B3 and B2 */}
        {(isNegotiating || isDeploying || isDone) && (
           <div style={{ position: 'absolute', left: '26%', top: '23%', width: '10%', height: '2px', background: '#06b6d4', transform: 'rotate(25deg)', animation: 'pulse-fiber 1s infinite alternate', boxShadow: '0 0 10px #06b6d4', zIndex: 1 }} />
        )}

        {/* Main transaction beam B2 -> Seller */}
        {(isDeploying || isDone) && (
           <div style={{ position: 'absolute', left: '32%', top: '40%', width: '38%', height: '3px', background: 'linear-gradient(90deg, #06b6d4, #a855f7)', transform: 'translateZ(30px) rotateY(-10deg)', animation: 'beam 1.5s infinite linear', boxShadow: '0 0 20px rgba(6,182,212,0.8)', zIndex: 1 }} />
        )}

        {/* Guild iNFT Crystal */}
        <div style={{
           position: 'absolute', left: '46%', top: '45%',
           width: '30px', height: '60px',
           background: 'linear-gradient(135deg, rgba(6,182,212,0.8), rgba(168,85,247,1))',
           clipPath: 'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)',
           boxShadow: '0 0 40px rgba(6,182,212,1)',
           animation: 'float-crystal 3s ease-in-out infinite',
           opacity: (isNegotiating || isDeploying || isDone) ? 1 : 0,
           transition: 'opacity 1s', transformStyle: 'preserve-3d', zIndex: 3
        }} />

        {/* KeeperHub Shield overhead */}
        <div style={{
           position: 'absolute', left: '50%', top: '20%', transform: 'translateX(-50%) translateZ(80px) rotateX(60deg)',
           width: '150px', height: '150px', borderRadius: '50%', border: '4px dashed rgba(6,182,212,0.5)',
           animation: 'spin-shield 10s linear infinite', opacity: (isDeploying || isDone) ? 1 : 0, transition: 'opacity 0.5s',
           boxShadow: 'inset 0 0 50px rgba(6,182,212,0.2), 0 0 50px rgba(6,182,212,0.4)', pointerEvents: 'none'
        }} />

        <RobotNode id="b1" label="B1 (Red)" x="5%" y="15%" scale={0.8} highlight="rgba(239,68,68,0.8)" hue={150} thought={getThought('b1')} isFailed={isDeploying || isDone} />
        <RobotNode id="b2" label="B2 (Cyan) - Guild Hero" x="20%" y="35%" scale={1.4} highlight="rgba(6,182,212,1)" hue={0} thought={getThought('b2')} />
        <RobotNode id="b3" label="B3 (Yellow)" x="35%" y="25%" scale={0.9} highlight="rgba(234,179,8,0.8)" hue={-150} thought={getThought('b3')} />

        <RobotNode id="seller" label="Seller (Purple)" x="70%" y="30%" scale={1.4} flip hue={100} highlight="rgba(168,85,247,1)" thought={getThought('seller')} />

      </div>
      <style dangerouslySetInnerHTML={{__html: `
        @keyframes beam { 0% { background-position: -200px; opacity: 0.5; } 50% { opacity: 1; } 100% { background-position: 400px; opacity: 0.5; } }
        @keyframes float-crystal { 0%, 100% { transform: translateZ(50px) translateY(0) rotateY(0deg); } 50% { transform: translateZ(60px) translateY(-15px) rotateY(180deg); } }
        @keyframes scan { 0% { left: 0%; opacity: 0; } 50% { opacity: 1; } 100% { left: 100%; opacity: 0; } }
        @keyframes pulse-fiber { 0% { opacity: 0.3; } 100% { opacity: 1; } }
        @keyframes spin-shield { 0% { transform: translateX(-50%) translateZ(80px) rotateX(70deg) rotateZ(0deg); } 100% { transform: translateX(-50%) translateZ(80px) rotateX(70deg) rotateZ(360deg); } }
      `}} />
    </div>
  );
}

export default function Dashboard() {
  const [activeTab, setActiveTab] = useState(AGENTS[0]);
  const [agentsState, setAgentsState] = useState<any>({
    buyer1: null, buyer2: null, buyer3: null, seller: null
  });
  
  const [sku, setSku] = useState("h100-pcie-hour");
  const [maxPrice, setMaxPrice] = useState(1.5);
  const [qty, setQty] = useState(10);
  const [simulating, setSimulating] = useState(false);
  const [keeperRunning, setKeeperRunning] = useState(false);
  const [paymentComplete, setPaymentComplete] = useState(false);

  useEffect(() => {
    // Poll all 4 agents natively for a unified network view
    const p = setInterval(async () => {
      const states: any = {};
      for (const ag of AGENTS) {
        try {
          const data = await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open("GET", `http://localhost:${ag.port}/status`);
            xhr.onload = () => {
              try { resolve(JSON.parse(xhr.responseText)); } 
              catch(e) { reject(e); }
            };
            xhr.onerror = () => reject(new Error("Network Error"));
            xhr.send();
          });
          states[ag.id] = data;
        } catch {
          states[ag.id] = null;
        }
      }
      setAgentsState(states);
    }, 1500);
    return () => clearInterval(p);
  }, []);

  // Track global progress to trigger confetti once when Payment is actually Complete
  useEffect(() => {
    if (paymentComplete && !window.sessionStorage.getItem("confettiDone")) {
       confetti({ particleCount: 200, spread: 120, origin: { y: 0.6 } });
       window.sessionStorage.setItem("confettiDone", "true");
    }
  }, [paymentComplete]);

  // ⚡ INDEPENDENT KEEPER WATCHER — fires whenever ANY path (manual or auto) hits "Settled"
  useEffect(() => {
    const b1 = agentsState.buyer1?.myCommits?.[0];
    const isSettled = b1?.statusStr?.includes("Settled");
    const hasAddress = !!b1?.address;
    const alreadyDone = paymentComplete || keeperRunning || window.sessionStorage.getItem("keeperFired");

    if (isSettled && hasAddress && !alreadyDone) {
      window.sessionStorage.setItem("keeperFired", "true");
      setKeeperRunning(true);
      console.log("[Keeper Watcher] Detected settled coalition. Auto-firing keeper for:", b1.address);

      fetch("/api/keeper", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: b1.address }),
      })
        .then(r => r.json())
        .then(data => {
          console.log("[Keeper] Result:", data);
          setKeeperRunning(false);
          setPaymentComplete(true);
        })
        .catch(err => {
          console.error("[Keeper] Error:", err);
          setKeeperRunning(false);
        });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentsState]);

  // Unified auto-simulate function
  const startSimulation = async () => {
    window.sessionStorage.removeItem("confettiDone");
    window.sessionStorage.removeItem("keeperFired");
    setSimulating(true);
    setKeeperRunning(false);
    setPaymentComplete(false);

    const intent = { sku, max_unit_price: maxPrice, qty, deadline_ms: Date.now() + 24 * 3600 * 1000 };
    
    try {
      // 1. Submit Buyer 1
      await fetch(`http://localhost:3001/submit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(intent) });
      
      // 2. Wait 3s, submit Buyer 2 (Simulating decentralized discovery)
      await new Promise(r => setTimeout(r, 3000));
      await fetch(`http://localhost:3002/submit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(intent) });
      
      // 3. Wait 3s, submit Buyer 3 -> This triggers k=3 logic!
      await new Promise(r => setTimeout(r, 3000));
      await fetch(`http://localhost:3003/submit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(intent) });
      
      // 4. Poll for Coalition Address explicitly to Trigger Keeper
      let deployedAddr = null;
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const res = await fetch(`http://localhost:3001/status`);
        const status = await res.json();
        const commit = status.myCommits?.[0];
        if (commit?.address && commit?.statusStr.includes("Settled")) {
           deployedAddr = commit.address;
           break;
        }
      }

      if (deployedAddr) {
         setKeeperRunning(true);
         const kResp = await fetch(`/api/keeper`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: deployedAddr }) });
         const kData = await kResp.json();
         console.log("Keeper Execution Log:", kData);
         setKeeperRunning(false);
         setPaymentComplete(true);
      }
    } catch(e) {
      console.log(e);
    }
    setSimulating(false);
  };

  const getGlobalState = () => {
     // deduce global state from Buyer 1's perspective
     const c = agentsState.buyer1?.myCommits?.[0];
     if (!c) return "idle";
     if (paymentComplete) return "paid";
     if (c.statusStr.includes("Settled")) return "settled";
     if (c.statusStr.includes("Deploying Coalition")) return "deploying";
     if (c.offer) return "negotiated";
     if (c.clusterSize === 3) return "revealing";
     return "broadcasting"; // k=1 or 2
  };

  const gState = getGlobalState();

  const renderAgentWorkflow = () => {
     // Determine active stage based on gState
     const stageIndex = 
        paymentComplete ? 5 : 
        gState === "settled" ? 4 : 
        gState === "deploying" ? 3 : 
        gState === "negotiated" ? 2 : 
        (gState === "revealing" || gState === "broadcasting" && agentsState.buyer1?.myCommits?.[0]) ? 1 : 0;

     const WorkflowNode = ({ title, icon: Icon, sub, active, done, delay }: any) => (
        <div className={`workflow-node ${active ? 'active-node' : done ? 'done-node' : 'pending-node'} animate-fade-in`} style={{ animationDelay: delay, display: 'flex', flexDirection: 'column', width: '140px', flexShrink: 0, background: active ? 'rgba(99, 102, 241, 0.15)' : 'var(--card-bg)', border: `1px solid ${active ? '#6366f1' : done ? '#10b981' : 'var(--card-border)'}`, borderRadius: '10px', padding: '0.75rem', position: 'relative', zIndex: 2, transition: 'all 0.3s', boxShadow: active ? '0 0 20px rgba(99, 102, 241, 0.3)' : 'none' }}>
           <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem' }}>
              <div style={{ background: active ? '#6366f1' : done ? '#10b981' : '#3f3f46', width: '32px', height: '32px', borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.3s' }}>
                 <Icon size={16} color="#ffffff" />
              </div>
              <span style={{ fontWeight: 600, fontSize: '0.9rem', color: active || done ? '#fff' : '#a1a1aa' }}>{title}</span>
           </div>
           <p style={{ fontSize: '0.75rem', color: '#a1a1aa', lineHeight: 1.4 }}>{sub}</p>
        </div>
     );

     const Connector = ({ active, done }: any) => (
        <div style={{ flex: 1, height: '2px', background: done ? '#10b981' : 'var(--card-border)', position: 'relative', minWidth: '30px' }}>
           {active && <div className="pulse-line" style={{ position: 'absolute', top: 0, left: 0, height: '100%', width: '100%', background: 'linear-gradient(90deg, transparent, #6366f1, transparent)', animation: 'slide-right 1.5s infinite linear' }} />}
        </div>
     );

     return (
        <div style={{ width: '100%', background: '#0a0a0f', borderRadius: '16px', border: '1px solid var(--card-border)', padding: '2rem 1.5rem', marginBottom: '2rem', overflowX: 'auto' }}>
           <style dangerouslySetInnerHTML={{__html: `
              @keyframes slide-right { 0% { transform: translateX(-100%); } 100% { transform: translateX(100%); } }
              .workflow-node { box-shadow: 0 4px 6px rgba(0,0,0,0.3); }
              .active-node { transform: translateY(-4px); }
           `}} />
           <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', minWidth: '620px' }}>
              <WorkflowNode title="1. Buyer Node" icon={Play} sub="Local Agent signs bulk-buying intent locally." done={stageIndex > 0} active={stageIndex === 1} delay="0s" />
              <Connector done={stageIndex > 1} active={stageIndex === 1} />
              <WorkflowNode title="2. P2P Mesh (k=3)" icon={Activity} sub="AXL Encrypted Tunnel discovers & groups peers." done={stageIndex > 1} active={stageIndex === 2} delay="0.1s" />
              <Connector done={stageIndex > 2} active={stageIndex === 2} />
              <WorkflowNode title="3. Seller Algorithm" icon={CheckCircle2} sub="Daemon dynamically evaluates demand & sets tier." done={stageIndex > 2} active={stageIndex === 3} delay="0.2s" />
              <Connector done={stageIndex > 3} active={stageIndex === 3} />
              <WorkflowNode title="4. Gensyn Testnet" icon={Network} sub="Agent deploys Smart Contract & funds escrow." done={stageIndex > 3} active={stageIndex === 4} delay="0.3s" />
              <Connector done={stageIndex > 4} active={stageIndex === 4} />
              <WorkflowNode title="5. KeeperHub" icon={Zap} sub="Node triggers payload sweeping funds to Seller." done={stageIndex >= 5} active={stageIndex === 5 && keeperRunning} delay="0.4s" />
           </div>
           <div style={{ marginTop: '1.5rem', textAlign: 'center', fontSize: '0.8rem', color: '#71717a', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
             Cryptography Workflow Architecture [Live Telemetry Tracking]
           </div>
        </div>
     );
  };



  const renderActiveTabContent = () => {
    const agState = agentsState[activeTab.id];
    const commit = agState?.myCommits?.[0]; // works for buyers
    const b1Commit = agentsState.buyer1?.myCommits?.[0]; // read source of truth for Seller UI

    // SELLER DASHBOARD — driven by live offer data from buyer1's committed cluster
    if (activeTab.type === "seller") {
       const isSelling = gState === "negotiated" || gState === "deploying" || gState === "settled" || gState === "paid";
       const offer = b1Commit?.offer;
       const nBuyers = b1Commit?.clusterSize ?? 0;
       const unitQty = b1Commit?.qty ?? 0;
       const totalUnits = nBuyers * unitQty;
       const maxPrice = b1Commit?.max_unit_price ?? 0;
       const tierPrice = offer?.tierUnitPrice ?? 0;
       const discountPct = maxPrice > 0 && tierPrice > 0 ? Math.round((1 - tierPrice / maxPrice) * 100) : 0;
       const totalPayout = tierPrice * totalUnits;

       return (
          <section className="glass-panel animate-fade-in animate-delay-1">
             <h2 style={{ fontSize: '1.5rem', fontWeight: 600, marginBottom: '1.5rem' }}>Dynamic Tier Evaluation</h2>
             {!isSelling ? (
                <div style={{ textAlign: 'center', color: '#a1a1aa', padding: '2rem 0' }}>
                  <p>Awaiting negotiate_request on GossipSub huddle topic…</p>
                  {agState && <p style={{color: '#6366f1', marginTop: '1rem', fontStyle: 'italic'}}>Seller peer online · X402 quote server active</p>}
                </div>
             ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
                   <div style={{ background: 'rgba(16, 185, 129, 0.05)', border: '1px solid #10b981', borderRadius: '12px', padding: '1.5rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1rem' }}>
                         <CheckCircle2 color="#10b981" />
                         <h3 style={{ fontSize: '1.25rem', fontWeight: 700, color: '#10b981' }}>Coalition Request Received & Evaluated</h3>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', color: '#e4e4e7', fontFamily: 'monospace' }}>
                        <p>&gt; SKU: <b>{b1Commit?.sku ?? "—"}</b></p>
                        <p>&gt; Buyers in Coalition: <b>{nBuyers}</b> × {unitQty} units = <b>{totalUnits} total units</b></p>
                        <p>&gt; Buyer Max Unit Price: <b>${maxPrice.toFixed(2)}</b></p>
                        {offer && <>
                          <p>&gt; Tier Threshold Met → Applied Bulk Discount: <b>-{discountPct}%</b></p>
                          <div style={{ marginTop: '1rem', padding: '1rem', background: '#000', borderRadius: '6px' }}>
                             <p style={{ color: '#10b981', fontSize: '1.2rem', fontWeight: 'bold' }}>FINAL BINDING OFFER: ${tierPrice.toFixed(2)} / unit</p>
                             <p style={{ color: '#a1a1aa', fontSize: '0.8rem', marginTop: '0.5rem' }}>
                               Coordinator paid X402 quote fee · offer valid until {new Date(offer.validUntilMs).toLocaleTimeString()}
                             </p>
                          </div>
                        </>}
                      </div>
                   </div>

                   {paymentComplete && b1Commit && offer && (
                     <div className="animate-fade-in" style={{ background: 'linear-gradient(135deg, rgba(56, 189, 248, 0.2), rgba(16, 185, 129, 0.2))', border: '1px solid #38bdf8', borderRadius: '12px', padding: '1.5rem' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1rem' }}>
                           <span style={{ background: '#38bdf8', color: '#000', padding: '0.25rem 0.5rem', borderRadius: '4px', fontWeight: 'bold' }}>PAYMENT RECEIVED</span>
                        </div>
                        <div style={{ color: '#fff', fontSize: '1.1rem' }}>
                          <p>KeeperHub called <code>commit()</code> on the Coalition escrow.</p>
                          <p style={{ marginTop: '0.5rem', fontWeight: 'bold', fontSize: '1.5rem' }}>
                            Payout: <span style={{color: '#10b981'}}>{totalUnits} units × ${tierPrice.toFixed(2)} = ${totalPayout.toFixed(2)} MockUSDC</span>
                          </p>
                          <p style={{ fontSize: '0.8rem', color: '#cbd5e1', marginTop: '0.5rem' }}>Coalition: {b1Commit.address}</p>
                        </div>
                     </div>
                   )}
                </div>
             )}
          </section>
       );
    }

    // BUYER DASHBOARD
    return (
      <>
        {!commit && (
          <section className="glass-panel animate-fade-in animate-delay-1">
            <h2 style={{ fontSize: '1.5rem', fontWeight: 600, marginBottom: '1.5rem' }}>Start Network Sequence</h2>
            <p style={{ color: '#a1a1aa', marginBottom: '2rem' }}>Configure the target constraints. Clicking 'Run Autonomous Sequence' will background-submit intents across independent decentralized nodes to trigger threshold mechanics.</p>
            
            <div className="form-grid" style={{ marginBottom: '2rem' }}>
              <div className="input-group">
                <label>SKU (Product ID)</label>
                <input type="text" value={sku} onChange={e => setSku(e.target.value)} required />
              </div>
              <div className="input-group">
                <label>Maximum Unit Price ($)</label>
                <input type="number" step="0.01" value={maxPrice} onChange={e => setMaxPrice(Number(e.target.value))} required />
              </div>
              <div className="input-group">
                <label>Quantity</label>
                <input type="number" value={qty} onChange={e => setQty(Number(e.target.value))} required />
              </div>
            </div>

            <button onClick={startSimulation} className="cta-button" disabled={simulating || keeperRunning} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', width: '100%' }}>
              {(simulating || keeperRunning) ? <Activity className="animate-spin" size={20} /> : <Play size={20} />}
              {keeperRunning ? "KeeperHub executing on-chain payment Commit..." : (simulating ? "Mesh Agents Executing..." : "Run Autonomous End-to-End Sequence")}
            </button>
          </section>
        )}

        {commit && (
           <section className="animate-fade-in animate-delay-2">
             <h2 style={{ fontSize: '1.5rem', fontWeight: 600, marginBottom: '1.5rem' }}>Final Execution Receipt & State</h2>
             
             {/* Final Finished View */}
             {(gState === "settled" || gState === "paid") ? (
               <div style={{ background: 'linear-gradient(180deg, rgba(16, 185, 129, 0.1) 0%, rgba(0,0,0,0) 100%)', border: '1px solid #10b981', borderRadius: '16px', padding: '2rem' }}>
                 <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
                    <div style={{ background: '#10b981', color: '#fff', width: '48px', height: '48px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 1rem auto' }}>
                      {keeperRunning ? <Activity className="animate-spin" size={24}/> : <CheckCircle2 size={32} />}
                    </div>
                    <h2 style={{ fontSize: '2rem', fontWeight: 800, color: '#10b981' }}>{paymentComplete ? "Purchase & Payment Complete!" : "Contract Settled, Awaiting Keeper..."}</h2>
                    <p style={{ color: '#a1a1aa' }}>{paymentComplete ? "The KeeperHub swept your escrow, deployed the contract, transferred funds to the Seller, and finalized your decentralized order." : "Coalition threshold met. Waiting for autonomous Keeper script to execute the payment."}</p>
                 </div>

                 <div style={{ background: 'rgba(0,0,0,0.5)', borderRadius: '12px', padding: '1.5rem', fontFamily: 'monospace' }}>
                   <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #333', paddingBottom: '1rem', marginBottom: '1rem' }}>
                     <span style={{ color: '#a1a1aa' }}>Ordered Item</span>
                     <span style={{ fontWeight: 600, color: '#fff' }}>{commit.sku}</span>
                   </div>
                   <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #333', paddingBottom: '1rem', marginBottom: '1rem' }}>
                     <span style={{ color: '#a1a1aa' }}>Order Qty</span>
                     <span style={{ fontWeight: 600, color: '#fff' }}>{commit.qty} Units</span>
                   </div>
                   <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #333', paddingBottom: '1rem', marginBottom: '1rem' }}>
                     <span style={{ color: '#a1a1aa' }}>Unit Price (Max)</span>
                     <span style={{ fontWeight: 600, color: '#f43f5e', textDecoration: 'line-through' }}>${commit.max_unit_price.toFixed(2)}</span>
                   </div>
                   <div style={{ display: 'flex', justifyContent: 'space-between', paddingBottom: '1rem' }}>
                     <span style={{ color: '#a1a1aa' }}>Unit Price (Auto-Negotiated)</span>
                     <span style={{ fontWeight: 800, color: '#10b981', fontSize: '1.25rem' }}>${commit.offer?.tierUnitPrice?.toFixed(2)}</span>
                   </div>
                 </div>

                 <div style={{ marginTop: '2rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    <a href={`https://gensyn-testnet.explorer.alchemy.com/address/${commit.address}`} target="_blank" rel="noreferrer" style={{ display: 'block', padding: '1rem', background: 'rgba(99,102,241,0.1)', border: '1px solid #6366f1', borderRadius: '8px', color: '#818cf8', textDecoration: 'none', textAlign: 'center', fontWeight: 'bold' }}>
                       View Coalition on Gensyn Testnet Explorer →
                    </a>
                    <a href="https://chainscan-galileo.0g.ai/address/0x86583710FB176b5a868262FCc95BFf0DfBeE130C" target="_blank" rel="noreferrer" style={{ display: 'block', padding: '1rem', background: 'rgba(56,189,248,0.1)', border: '1px solid #38bdf8', borderRadius: '8px', color: '#7dd3fc', textDecoration: 'none', textAlign: 'center', fontWeight: 'bold' }}>
                       Verify Buyer Profile iNFT on 0G Testnet →
                    </a>
                 </div>
               </div>
             ) : (
               <div className="glass-panel status-card border-glow">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <h3 style={{ fontSize: '1.125rem', fontWeight: 700 }}>{commit.sku}</h3>
                    <span className="status-badge badge-forming animate-pulse">{commit.statusStr}</span>
                  </div>
                  <div style={{ fontSize: '0.875rem', color: '#a1a1aa', display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '1rem' }}>
                    <p>Mesh Members Confirmed: {commit.clusterSize} / 3</p>
                    <p>Target Qty: {commit.qty}</p>
                    <p>Constraints: Max ${commit.max_unit_price.toFixed(2)}</p>
                    {commit.offer && (
                        <p style={{ color: '#10b981', fontWeight: 600 }}>Discount Evaluated: ${commit.offer.tierUnitPrice.toFixed(2)}</p>
                    )}
                  </div>
               </div>
             )}
           </section>
        )}
      </>
    );
  };

  return (
    <div style={{ display: 'flex', minHeight: '100vh', width: '100vw' }}>
      {/* Sidebar */}
      <aside style={{ width: '250px', background: 'rgba(255,255,255,0.02)', borderRight: '1px solid var(--card-border)', padding: '2rem 1rem' }}>
        <h2 style={{ fontSize: '1.25rem', fontWeight: 800, marginBottom: '2rem', paddingLeft: '1rem', background: 'linear-gradient(135deg, var(--foreground), var(--primary))', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
          Huddle Network
        </h2>
        
        <nav style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {AGENTS.map(agent => (
            <button 
              key={agent.id}
              onClick={() => setActiveTab(agent)}
              style={{
                background: activeTab.id === agent.id ? 'rgba(99, 102, 241, 0.1)' : 'transparent',
                border: `1px solid ${activeTab.id === agent.id ? 'var(--primary)' : 'transparent'}`,
                color: activeTab.id === agent.id ? 'var(--primary)' : 'var(--foreground)',
                padding: '0.75rem 1rem',
                borderRadius: '8px',
                textAlign: 'left',
                fontWeight: 600,
                cursor: 'pointer',
                transition: 'all 0.2s'
              }}
            >
              {agent.name} {agentsState[agent.id]?.myCommits?.[0] ? "🟢" : ""}
            </button>
          ))}
        </nav>
      </aside>

      {/* Main Content & Terminal Layout Container */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        
        {/* Center Canvas */}
        <main className="container" style={{ flex: 1, paddingRight: '2rem', overflowY: 'auto', maxHeight: '100vh' }}>
          <div className="bg-blobs">
            <div className="blob blob-1"></div>
            <div className="blob blob-2"></div>
          </div>
          
          <header className="header animate-fade-in" style={{ marginBottom: '2rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <h1 className="header-title">{activeTab.name} View</h1>
              <div className="agent-info" style={{ color: '#a1a1aa', fontWeight: 500, marginTop: '0.5rem' }}>
                {agentsState[activeTab.id] ? (
                   <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                     <span style={{ display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', background: '#10b981' }}></span> 
                     Agent Sync Active (Port: {activeTab.port})
                   </span>
                ) : (
                   <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                     <span style={{ display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', background: '#f43f5e' }}></span> 
                     Agent Offline
                   </span>
                )}
              </div>
            </div>
          </header>

          {renderAgentWorkflow()}
          <Agent3DScene gState={gState} />
          {renderActiveTabContent()}

        </main>

        {/* Right Sidebar - Interactive Terminal */}
        <TerminalPanel
          activeTab={activeTab}
          agentState={agentsState[activeTab.id]}
          paymentComplete={paymentComplete}
          onReset={() => { setPaymentComplete(false); setSimulating(false); setKeeperRunning(false); }}
        />

      </div>
    </div>
  );
}

// ─── Terminal Panel Component ─────────────────────────────────────────────────
function TerminalPanel({ activeTab, agentState, paymentComplete, onReset }: any) {
  const [agentRunning, setAgentRunning] = useState(false);
  const [localSku, setLocalSku] = useState("h100-pcie-hour");
  const [localPrice, setLocalPrice] = useState("1.5");
  const [localQty, setLocalQty] = useState("10");
  const [posting, setPosting] = useState(false);
  const [cmdLog, setCmdLog] = useState<string[]>([]);
  const logsEndRef = (el: HTMLDivElement | null) => el?.scrollIntoView({ behavior: "smooth" });

  const addLog = (msg: string) => setCmdLog(prev => [...prev.slice(-49), `[${new Date().toISOString().substring(11, 19)}] ${msg}`]);

  const handleStartAgent = async () => {
    setAgentRunning(true);
    addLog(`$ Spawning daemon for ${activeTab.name} on port ${activeTab.port}...`);
    try {
      const res = await fetch("/api/spawn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: activeTab.id, port: activeTab.port, type: activeTab.type })
      });
      const data = await res.json();
      if (data.success) addLog(`✓ Agent daemon started. PID: ${data.pid ?? "OK"}`);
      else { addLog(`✗ Failed: ${data.error}`); setAgentRunning(false); }
    } catch(e) {
      addLog(`✗ API error: ${(e as Error).message}`);
      setAgentRunning(false);
    }
  };

  const handleStopAgent = async () => {
    addLog(`$ Sending SIGTERM to ${activeTab.name} daemon (port ${activeTab.port})...`);
    try {
      await fetch("/api/spawn", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ port: activeTab.port })
      });
      addLog(`✓ Agent stopped.`);
      setAgentRunning(false);
    } catch(e) {
      addLog(`✗ Stop failed: ${(e as Error).message}`);
    }
  };

  const handlePostIntent = async () => {
    if (!agentState) { addLog("✗ Agent offline — start it first."); return; }
    setPosting(true);
    const intent = { sku: localSku, max_unit_price: Number(localPrice), qty: Number(localQty), deadline_ms: Date.now() + 24 * 3600 * 1000 };
    addLog(`$ POST http://localhost:${activeTab.port}/submit`);
    addLog(`  body: ${JSON.stringify(intent)}`);
    try {
      const res = await fetch(`http://localhost:${activeTab.port}/submit`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(intent)
      });
      const data = await res.json();
      if (data.success) addLog(`✓ Intent accepted by agent. Propagating to AXL mesh...`);
      else addLog(`✗ Agent rejected: ${JSON.stringify(data)}`);
    } catch(e) {
      addLog(`✗ Fetch error: ${(e as Error).message}`);
    }
    setPosting(false);
  };

  const handleReset = () => {
    addLog("$ Clearing session state. Ready for new round.");
    window.sessionStorage.removeItem("confettiDone");
    window.sessionStorage.removeItem("keeperFired");
    onReset();
  };

  const isOnline = !!agentState;
  const isBuyer = activeTab.type === "buyer";
  const daemonLogs: string[] = agentState?.logs ?? [];
  const combinedLogs = [...cmdLog, ...daemonLogs];

  return (
    <aside style={{ width: '420px', background: '#030305', borderLeft: '1px solid #1f1f2e', display: 'flex', flexDirection: 'column', height: '100vh', boxShadow: '-10px 0 30px rgba(0,0,0,0.6)' }}>
      {/* Title bar */}
      <div style={{ padding: '0.75rem 1rem', borderBottom: '1px solid #1f1f2e', background: '#0a0a0f', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <div style={{ display: 'flex', gap: '5px' }}>
            <div style={{ width: '11px', height: '11px', borderRadius: '50%', background: '#f43f5e' }}></div>
            <div style={{ width: '11px', height: '11px', borderRadius: '50%', background: '#eab308' }}></div>
            <div style={{ width: '11px', height: '11px', borderRadius: '50%', background: '#10b981' }}></div>
          </div>
          <span style={{ color: '#8b8b99', fontSize: '0.75rem', fontFamily: 'monospace', fontWeight: 700, marginLeft: '4px' }}>
            {activeTab.name.toUpperCase()} // LIVE CONSOLE
          </span>
        </div>
        <span style={{ fontSize: '0.65rem', fontFamily: 'monospace', padding: '2px 8px', borderRadius: '4px', background: isOnline ? 'rgba(16,185,129,0.15)' : 'rgba(244,63,94,0.15)', color: isOnline ? '#10b981' : '#f43f5e', border: `1px solid ${isOnline ? '#10b981' : '#f43f5e'}` }}>
          {isOnline ? "● ONLINE" : "○ OFFLINE"}
        </span>
      </div>

      {/* Agent controls */}
      <div style={{ padding: '0.75rem 1rem', borderBottom: '1px solid #1f1f2e', background: '#05050a', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        {!isOnline ? (
          <button onClick={handleStartAgent} style={{ flex: 1, padding: '0.5rem', background: 'rgba(99,102,241,0.15)', border: '1px solid #6366f1', color: '#818cf8', borderRadius: '6px', cursor: 'pointer', fontFamily: 'monospace', fontSize: '0.75rem', fontWeight: 700 }}>
            ▶ Start Agent
          </button>
        ) : (
          <button onClick={handleStopAgent} style={{ flex: 1, padding: '0.5rem', background: 'rgba(244,63,94,0.1)', border: '1px solid #f43f5e', color: '#fb7185', borderRadius: '6px', cursor: 'pointer', fontFamily: 'monospace', fontSize: '0.75rem', fontWeight: 700 }}>
            ■ Stop Agent
          </button>
        )}
        {paymentComplete && (
          <button onClick={handleReset} style={{ flex: 1, padding: '0.5rem', background: 'rgba(234,179,8,0.1)', border: '1px solid #eab308', color: '#facc15', borderRadius: '6px', cursor: 'pointer', fontFamily: 'monospace', fontSize: '0.75rem', fontWeight: 700 }}>
            ↺ New Round
          </button>
        )}
      </div>

      {/* Live log stream */}
      <div style={{ flex: 1, padding: '0.75rem 1rem', overflowY: 'auto', fontFamily: 'monospace', fontSize: '0.78rem', lineHeight: 1.6, color: '#10b981' }}>
        {combinedLogs.length === 0 && (
          <p style={{ color: '#555', fontStyle: 'italic' }}>Awaiting daemon output...</p>
        )}
        {combinedLogs.map((log, idx) => (
          <div key={idx} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', marginBottom: '4px', color: log.startsWith("[") ? '#10b981' : '#a3e635' }}>
            <span style={{ color: '#0ea5e9', marginRight: '6px' }}>{">"}</span>{log}
          </div>
        ))}
        <div ref={logsEndRef} />
      </div>

      {/* Intent Command Input (buyers only) */}
      {isBuyer && (
        <div style={{ padding: '1rem', borderTop: '1px solid #1f1f2e', background: '#0a0a0f', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <p style={{ color: '#555', fontSize: '0.7rem', fontFamily: 'monospace', marginBottom: '0.25rem' }}>$ post_intent --agent {activeTab.id}</p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.4rem' }}>
            <input value={localSku} onChange={e => setLocalSku(e.target.value)} placeholder="SKU" style={{ background: '#111', border: '1px solid #333', color: '#10b981', borderRadius: '4px', padding: '0.4rem', fontFamily: 'monospace', fontSize: '0.72rem' }} />
            <input value={localPrice} onChange={e => setLocalPrice(e.target.value)} type="number" placeholder="Max $" style={{ background: '#111', border: '1px solid #333', color: '#10b981', borderRadius: '4px', padding: '0.4rem', fontFamily: 'monospace', fontSize: '0.72rem' }} />
            <input value={localQty} onChange={e => setLocalQty(e.target.value)} type="number" placeholder="Qty" style={{ background: '#111', border: '1px solid #333', color: '#10b981', borderRadius: '4px', padding: '0.4rem', fontFamily: 'monospace', fontSize: '0.72rem' }} />
          </div>
          <button onClick={handlePostIntent} disabled={posting || !isOnline} style={{ padding: '0.5rem', background: posting ? 'rgba(16,185,129,0.1)' : 'rgba(16,185,129,0.15)', border: '1px solid #10b981', color: '#10b981', borderRadius: '6px', cursor: isOnline ? 'pointer' : 'not-allowed', fontFamily: 'monospace', fontSize: '0.75rem', fontWeight: 700 }}>
            {posting ? "Posting..." : "$ post intent →"}
          </button>
        </div>
      )}
    </aside>
  );
}

// Mini inner component for the graph graphic
function MeshNode({ label, active, right, x, y, isSeller = false }: any) {
   return (
      <div style={{ position: 'absolute', [right ? 'right' : 'left']: `${x}px`, top: `${y}px`, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
         <div style={{ width: '40px', height: '40px', borderRadius: '50%', background: isSeller ? 'rgba(16,185,129,0.2)' : 'rgba(255,255,255,0.05)', border: `2px solid ${active ? (isSeller ? '#10b981' : '#6366f1') : '#333'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.5s', boxShadow: active ? `0 0 15px ${isSeller ? '#10b981' : '#6366f1'}` : 'none' }}>
           <span style={{ fontSize: '0.75rem' }}>{isSeller ? "S" : "B"}</span>
         </div>
         <span style={{ fontSize: '0.75rem', marginTop: '0.5rem', color: active ? '#fff' : '#666', fontWeight: active ? 'bold' : 'normal' }}>{label}</span>
      </div>
   )
}
