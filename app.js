/* Supply Chain Autopilot — single-page demo app (no build step).
   Focus: synthetic but “live-feeling” state changes, explainable heuristics, approve & execute.
*/
(function(){
  "use strict";

  // ---------- Utilities ----------
  const fmtUSD = (n) => n.toLocaleString(undefined,{style:"currency",currency:"USD",maximumFractionDigits:0});
  const fmtNum = (n, d=0) => n.toLocaleString(undefined,{maximumFractionDigits:d});
  const clamp = (x,a,b)=>Math.max(a,Math.min(b,x));
  const sigmoid = (x)=> 1/(1+Math.exp(-x));
  const round = (x, d=2)=> Math.round(x*Math.pow(10,d))/Math.pow(10,d);

  function mulberry32(seed){
    let a = seed >>> 0;
    return function(){
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    }
  }
  function seededShuffle(arr, rand){
    const a = arr.slice();
    for(let i=a.length-1;i>0;i--){
      const j = Math.floor(rand()*(i+1));
      [a[i],a[j]]=[a[j],a[i]];
    }
    return a;
  }

  function downloadJson(filename, obj){
    const blob = new Blob([JSON.stringify(obj,null,2)], {type:"application/json"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function toast(title, detail){
    const el = document.createElement("div");
    el.className = "toast";
    el.innerHTML = `<div class="t">${escapeHtml(title)}</div><div class="d">${escapeHtml(detail||"")}</div>`;
    document.body.appendChild(el);
    setTimeout(()=>{ el.remove(); }, 3200);
  }

  function escapeHtml(str){
    return (""+str).replace(/[&<>"']/g, m=>({
      "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
    }[m]));
  }

  // Leaflet default icons: fix missing marker assets when served from CDN
  function fixLeafletIcons(){
    if(!window.L) return;
    try{
      delete L.Icon.Default.prototype._getIconUrl;
      L.Icon.Default.mergeOptions({
        iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
        iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
        shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
      });
    }catch(e){}
  }

  // ---------- Synthetic data generator ----------
  function generateBaseline(seed=20251212){
    const rand = mulberry32(seed);
    const skus = [
      {id:"SKU-CLX-001", name:"Disinfecting Wipes 35ct", unitPrice:6.49, unitMargin:2.10, demandClass:"fast"},
      {id:"SKU-CLX-002", name:"Bleach 121oz", unitPrice:4.99, unitMargin:1.60, demandClass:"fast"},
      {id:"SKU-CLX-003", name:"Trash Bags 13gal 80ct", unitPrice:10.99, unitMargin:3.10, demandClass:"med"},
      {id:"SKU-CLX-004", name:"Pine-Sol 60oz", unitPrice:5.79, unitMargin:1.90, demandClass:"med"},
      {id:"SKU-CLX-005", name:"Glad Wrap 200sqft", unitPrice:4.59, unitMargin:1.35, demandClass:"slow"},
      {id:"SKU-CLX-006", name:"Kingsford Charcoal 16lb", unitPrice:12.99, unitMargin:3.60, demandClass:"seasonal"},
    ];

    // Roughly-realistic US node coordinates
    const plants = [
      {id:"PL-ATL", name:"Plant - Atlanta, GA", type:"plant", lat:33.7490, lon:-84.3880},
      {id:"PL-CHI", name:"Plant - Chicago, IL", type:"plant", lat:41.8781, lon:-87.6298},
      {id:"PL-DAL", name:"Plant - Dallas, TX", type:"plant", lat:32.7767, lon:-96.7970},
      {id:"PL-LAX", name:"Plant - Los Angeles, CA", type:"plant", lat:34.0522, lon:-118.2437},
    ];
    const dcs = [
      {id:"DC-NJ",  name:"DC - New Jersey", type:"dc", lat:40.0583, lon:-74.4057, capacity: 1250},
      {id:"DC-PA",  name:"DC - Central PA", type:"dc", lat:40.2732, lon:-76.8867, capacity: 1050},
      {id:"DC-GA",  name:"DC - Atlanta", type:"dc", lat:33.7490, lon:-84.3880, capacity: 980},
      {id:"DC-TX",  name:"DC - Dallas", type:"dc", lat:32.7767, lon:-96.7970, capacity: 1120},
      {id:"DC-IL",  name:"DC - Joliet", type:"dc", lat:41.5250, lon:-88.0817, capacity: 1000},
      {id:"DC-CA",  name:"DC - Inland Empire", type:"dc", lat:34.1064, lon:-117.5931, capacity: 1320},
    ];

    const nodes = plants.concat(dcs);

    // Carriers and baseline performance
    const carriers = [
      {id:"CAR-OMNI", name:"OmniTrans", onTime: 0.91, costIndex: 1.00, capacityIndex: 1.00},
      {id:"CAR-NOVA", name:"Nova Freight", onTime: 0.88, costIndex: 0.96, capacityIndex: 0.92},
      {id:"CAR-ARROW", name:"Arrow Logistics", onTime: 0.93, costIndex: 1.06, capacityIndex: 0.98},
      {id:"CAR-HARBOR", name:"HarborLine", onTime: 0.86, costIndex: 0.93, capacityIndex: 0.88},
    ];

    // Compute distance in miles using a quick haversine
    const R = 3958.8;
    function distMiles(a,b){
      const toRad = (x)=> x*Math.PI/180;
      const dLat = toRad(b.lat-a.lat);
      const dLon = toRad(b.lon-a.lon);
      const lat1 = toRad(a.lat), lat2=toRad(b.lat);
      const h = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
      return 2*R*Math.asin(Math.sqrt(h));
    }

    // Transit days: rough 500 miles/day + handling
    function transitDays(miles){
      const base = miles/520;
      return clamp(Math.round(base + 1.2), 1, 7);
    }

    // Lanes: plant -> dc
    const lanes = [];
    for(const p of plants){
      for(const d of dcs){
        const miles = distMiles(p,d);
        const days = transitDays(miles);
        // $/mile baseline
        const baseRate = 2.10 + (rand()*0.75); // 2.10-2.85
        lanes.push({
          id: `LANE-${p.id}-${d.id}`,
          from: p.id, to: d.id,
          miles: Math.round(miles),
          transitDays: days,
          ratePerMile: round(baseRate,2),
        });
      }
    }

    // Inventory: units by DC x SKU
    const inventory = {};
    for(const dc of dcs){
      inventory[dc.id] = {};
      for(const sku of skus){
        let base = 0;
        if(sku.demandClass==="fast") base = 2200 + Math.floor(rand()*900);
        else if(sku.demandClass==="med") base = 1600 + Math.floor(rand()*800);
        else if(sku.demandClass==="slow") base = 900 + Math.floor(rand()*500);
        else base = 1300 + Math.floor(rand()*1200);
        // add regional skew
        const coast = (dc.id==="DC-CA" || dc.id==="DC-NJ") ? 1.12 : 1.00;
        inventory[dc.id][sku.id] = Math.floor(base*coast*(0.75 + rand()*0.6));
      }
    }

    // Demand per day by DC x SKU (forecast)
    const demand = {};
    for(const dc of dcs){
      demand[dc.id] = {};
      for(const sku of skus){
        let base = 0;
        if(sku.demandClass==="fast") base = 160 + rand()*60;
        else if(sku.demandClass==="med") base = 90 + rand()*40;
        else if(sku.demandClass==="slow") base = 45 + rand()*20;
        else base = 60 + rand()*70; // seasonal
        // regional adjustments
        const west = (dc.id==="DC-CA") ? 1.14 : 1.00;
        const east = (dc.id==="DC-NJ"||dc.id==="DC-PA") ? 1.10 : 1.00;
        demand[dc.id][sku.id] = round(base*west*east, 1);
      }
    }

    // Fuel index series (last 14 days) baseline 1.00 with drift
    const fuelIndex = [];
    let v = 1.00 + (rand()*0.08 - 0.04);
    for(let i=13;i>=0;i--){
      v = v + (rand()*0.02 - 0.01);
      fuelIndex.push({day: -i, index: round(clamp(v,0.85,1.25),3)});
    }

    // Shipments: mix of inbound plant->dc and inter-DC transfers (some late risks)
    const shipments = [];
    const laneById = Object.fromEntries(lanes.map(l=>[l.id,l]));
    const laneFromTo = {};
    for(const l of lanes){ laneFromTo[`${l.from}|${l.to}`]=l; }

    const allDcIds = dcs.map(d=>d.id);
    const carrierIds = carriers.map(c=>c.id);

    let shipId = 1000;
    function pick(arr){ return arr[Math.floor(rand()*arr.length)]; }

    for(let i=0;i<34;i++){
      const fromPlant = pick(plants).id;
      const toDc = pick(dcs).id;
      const lane = laneFromTo[`${fromPlant}|${toDc}`];
      const sku = pick(skus).id;
      const qty = 600 + Math.floor(rand()*900);
      const carrier = pick(carrierIds);
      const baseDays = lane.transitDays;
      const progress = rand(); // 0..1
      const etaDays = clamp(Math.ceil(baseDays*(1-progress)), 0, 7);
      shipments.push({
        id:`SHP-${shipId++}`,
        kind:"inbound",
        from: fromPlant,
        to: toDc,
        laneId: lane.id,
        sku, qty,
        carrier,
        createdDay: 0,
        etaDays,
        baseTransitDays: baseDays,
        penalty: 8500,
        status: etaDays===0 ? "arriving" : "in_transit",
        cost: 0, // computed
      });
    }

    // a few existing transfers to make it “real”
    for(let i=0;i<10;i++){
      const fromDc = pick(allDcIds);
      let toDc = pick(allDcIds);
      if(toDc===fromDc) toDc = pick(allDcIds);
      const sku = pick(skus).id;
      const qty = 300 + Math.floor(rand()*600);
      // approximate miles using representative plant lane distances (hack)
      const miles = 350 + Math.floor(rand()*850);
      const days = clamp(Math.round(miles/520 + 1.1),1,6);
      const carrier = pick(carrierIds);
      shipments.push({
        id:`SHP-${shipId++}`,
        kind:"transfer",
        from: fromDc,
        to: toDc,
        laneId: null,
        miles,
        sku, qty,
        carrier,
        createdDay: 0,
        etaDays: clamp(Math.ceil(days*(0.3+rand()*0.8)),0,6),
        baseTransitDays: days,
        penalty: 6000,
        status: "in_transit",
        cost: 0,
      });
    }

    // compute shipment freight cost baseline
    const rateBase = 2.45;
    for(const s of shipments){
      const miles = s.kind==="inbound" ? laneById[s.laneId].miles : s.miles;
      const carrierObj = carriers.find(c=>c.id===s.carrier);
      const costIndex = carrierObj ? carrierObj.costIndex : 1.0;
      s.cost = Math.round(miles * rateBase * costIndex);
    }

    // DC utilization proxy (inbound/outbound volume) will be derived each tick
    return {
      meta:{seed, generatedAt: new Date().toISOString()},
      skus, nodes, plants, dcs, carriers, lanes, laneById,
      inventory, demand, fuelIndex, shipments,
    };
  }

  // ---------- App State ----------
  const BASE_SEED = 20251212;
  let baseline = generateBaseline(BASE_SEED);

  const state = {
    day: 0, // simulation day counter
    simRunning: false,
    simTimer: null,
    scenario: {
      dcOutage: false,
      carrierDisruption: false,
      demandSpike: false,
      cyberDegraded: false,
    },
    scenarioPinned: { // which assets are “hit” by the scenario once toggled on
      outageDcId: null,
      disruptedCarrierId: null,
      spikeSkuId: null,
    },
    inventory: deepCopy(baseline.inventory),
    shipments: deepCopy(baseline.shipments),
    fuelIndex: deepCopy(baseline.fuelIndex),
    actionLog: [],
    overflowBoost: {}, // dcId -> remaining days of capacity relief
    ui: {
      selectedExceptionId: null,
      selectedSkuId: baseline.skus[0].id,
      lastRoute: "#/exec",
      lastMap: null,
      charts: {},
    }
  };

  function deepCopy(x){ return JSON.parse(JSON.stringify(x)); }

  // ---------- Model / Analytics ----------
  function getFuelDrift(){
    const arr = state.fuelIndex;
    if(arr.length<2) return 0;
    const a = arr[arr.length-2].index;
    const b = arr[arr.length-1].index;
    return (b-a)/a; // ~daily drift
  }

  function scenarioMultipliers(){
    // baseline multipliers (applied in derived calculations, not directly overwriting base objects)
    let dcCapMult = {}; // dcId -> multiplier
    let carrierOnTimeDelta = {}; // carrierId -> delta
    let demandMult = {}; // skuId -> multiplier
    let planningFriction = 0;

    const dcs = baseline.dcs;
    const carriers = baseline.carriers;
    const skus = baseline.skus;

    for(const dc of dcs) dcCapMult[dc.id] = 1.0;
    for(const c of carriers) carrierOnTimeDelta[c.id] = 0.0;
    for(const sku of skus) demandMult[sku.id] = 1.0;

    // DC outage (one DC) reduces throughput & adds delay risk for shipments touching it
    if(state.scenario.dcOutage){
      const dcId = state.scenarioPinned.outageDcId || dcs[Math.floor(mulberry32(BASE_SEED+11)()*dcs.length)].id;
      state.scenarioPinned.outageDcId = dcId;
      dcCapMult[dcId] = 0.42;
    }else{
      state.scenarioPinned.outageDcId = null;
    }

    // Carrier disruption reduces on-time of one carrier and capacity (modeled via late probability)
    if(state.scenario.carrierDisruption){
      const cId = state.scenarioPinned.disruptedCarrierId || carriers[Math.floor(mulberry32(BASE_SEED+22)()*carriers.length)].id;
      state.scenarioPinned.disruptedCarrierId = cId;
      carrierOnTimeDelta[cId] = -0.14;
    }else{
      state.scenarioPinned.disruptedCarrierId = null;
    }

    // Demand spike increases demand for a “hit” SKU
    if(state.scenario.demandSpike){
      const skuId = state.scenarioPinned.spikeSkuId || skus[Math.floor(mulberry32(BASE_SEED+33)()*skus.length)].id;
      state.scenarioPinned.spikeSkuId = skuId;
      demandMult[skuId] = 1.28;
    }else{
      state.scenarioPinned.spikeSkuId = null;
    }

    // Cyber degraded mode: more friction, delayed decisioning/visibility
    if(state.scenario.cyberDegraded){
      planningFriction = 0.18; // increases late probability / reduces effective execution
    }


    // Overflow / temp capacity relief (from executed actions)
    for(const dcId of Object.keys(state.overflowBoost||{})){
      const daysLeft = state.overflowBoost[dcId]||0;
      if(daysLeft>0) dcCapMult[dcId] = (dcCapMult[dcId]||1.0) * 1.18;
    }

    return {dcCapMult, carrierOnTimeDelta, demandMult, planningFriction};
  }

  function computeLateProbability(shipment, multipliers){
    // Explainable, consistent model:
    // lateProb = sigmoid( w1*(miles/1000 - 0.7) + w2*(1 - carrierOnTimeAdj) + w3*fuelVol + w4*outageTouch + w5*cyberFriction )
    const carriers = baseline.carriers;
    const laneById = baseline.laneById;
    const from = shipment.from;
    const to = shipment.to;

    const miles = shipment.kind==="inbound" ? laneById[shipment.laneId].miles : shipment.miles;
    const carrier = carriers.find(c=>c.id===shipment.carrier) || {onTime:0.88};
    const onTimeAdj = clamp(carrier.onTime + (multipliers.carrierOnTimeDelta[shipment.carrier]||0), 0.65, 0.98);
    const fuelVol = clamp(Math.abs(getFuelDrift())*12, 0, 0.25);

    const outageDc = state.scenarioPinned.outageDcId;
    const outageTouch = (state.scenario.dcOutage && (from===outageDc || to===outageDc)) ? 1 : 0;

    const x =
      1.15*((miles/1000) - 0.7) +
      2.00*(1 - onTimeAdj) +
      2.25*fuelVol +
      1.25*outageTouch +
      1.55*(multipliers.planningFriction||0);

    const p = sigmoid(x);
    return clamp(p, 0.03, 0.92);
  }

  function expectedTotalCostForRetender(shipment, carrierId, multipliers){
    const carriers = baseline.carriers;
    const laneById = baseline.laneById;
    const miles = shipment.kind==="inbound" ? laneById[shipment.laneId].miles : shipment.miles;
    const carrier = carriers.find(c=>c.id===carrierId) || {costIndex:1.0};
    const baseRate = 2.45 * carrier.costIndex; // $/mile
    const freight = miles * baseRate;
    const tmp = deepCopy(shipment);
    tmp.carrier = carrierId;
    const lateProb = computeLateProbability(tmp, multipliers);
    const penalty = shipment.penalty || 7000;
    return {
      freight: Math.round(freight),
      lateProb: lateProb,
      penalty: penalty,
      expectedTotal: Math.round(freight + lateProb*penalty),
    };
  }

  function deriveKpisAndExceptions(){
    const m = scenarioMultipliers();
    const dcs = baseline.dcs;
    const skus = baseline.skus;

    // Utilization proxy per DC (from shipments in/out + scenario)
    const util = {};
    for(const dc of dcs) util[dc.id] = {inbound:0, outbound:0, capacity: Math.round(dc.capacity*(m.dcCapMult[dc.id]||1)), utilization:0, risk:0};

    // Count inbound shipments to DC as inbound volume; transfers too
    for(const s of state.shipments){
      if(s.status==="delivered") continue;
      if(s.to && util[s.to]) util[s.to].inbound += s.qty;
      if(s.from && util[s.from] && s.kind==="transfer") util[s.from].outbound += s.qty;
    }

    for(const dc of dcs){
      const u = util[dc.id];
      const flow = u.inbound*0.6 + u.outbound*0.4; // proxy
      u.utilization = clamp(flow / Math.max(1,u.capacity), 0, 1.6);
      // Risk increases quickly after ~85% utilization
      u.risk = clamp(sigmoid(9*(u.utilization - 0.86)), 0, 0.99);
    }

    // Inventory risk (days-of-cover)
    const invExceptions = [];
    const todayDemand = (dcId, skuId) => {
      const base = baseline.demand[dcId][skuId] || 0;
      const mult = m.demandMult[skuId] || 1.0;
      // degraded mode visibility: planning friction effectively increases demand uncertainty, modeled as slight uplift
      const cyber = state.scenario.cyberDegraded ? 1.05 : 1.0;
      return base * mult * cyber;
    };

    const inboundByDcSku = {};
    for(const dc of dcs){
      inboundByDcSku[dc.id] = {};
      for(const sku of skus) inboundByDcSku[dc.id][sku.id] = 0;
    }
    for(const s of state.shipments){
      if(s.status==="delivered") continue;
      if(s.to && inboundByDcSku[s.to] && inboundByDcSku[s.to][s.sku]!=null){
        inboundByDcSku[s.to][s.sku] += s.qty;
      }
    }

    for(const dc of dcs){
      for(const sku of skus){
        const onHand = state.inventory[dc.id][sku.id];
        const d = Math.max(0.1, todayDemand(dc.id, sku.id));
        const doc = onHand / d;
        const docTargetLow = 7.0;
        const docTargetHigh = 21.0;

        // expected shortage next 7 days if no inbound arrives in time
        // simple: shortageUnits = max(0, 7*d - (onHand + inboundWithin7))
        const inbound = inboundByDcSku[dc.id][sku.id];
        const shortage = Math.max(0, Math.round(7*d - (onHand + 0.55*inbound)));
        const valueAtRisk = shortage * sku.unitMargin * 3.0; // margin-weighted service risk
        const dcRisk = util[dc.id].risk;
        const spikeHit = (state.scenario.demandSpike && state.scenarioPinned.spikeSkuId===sku.id) ? 0.16 : 0;

        const riskScore = clamp(
          0.55*clamp((docTargetLow - doc)/docTargetLow, 0, 1) +
          0.25*dcRisk +
          0.12*(state.scenario.dcOutage && state.scenarioPinned.outageDcId===dc.id ? 1:0) +
          0.08*spikeHit,
          0, 1
        );

        if(doc < 10.0 || riskScore > 0.62){
          invExceptions.push({
            id:`EXC-INV-${dc.id}-${sku.id}`,
            type:"Inventory Coverage Risk",
            dcId: dc.id,
            skuId: sku.id,
            doc: round(doc,1),
            shortage,
            valueAtRisk: Math.round(valueAtRisk),
            riskScore: round(riskScore,2),
            why: buildWhy({kind:"inv", dc, sku, doc, shortage, dcRisk, scenario:state.scenario, pinned:state.scenarioPinned}),
          });
        }
      }
    }

    // Shipment exceptions (late risk + penalty)
    const shipExceptions = [];
    for(const s of state.shipments){
      if(s.status==="delivered") continue;
      const lp = computeLateProbability(s, m);
      if(lp > 0.40){
        const varUSD = Math.round(lp * (s.penalty||7000));
        const riskScore = clamp(0.55*(lp) + 0.25*(state.scenario.cyberDegraded?0.2:0) + 0.20*(state.scenario.dcOutage?0.15:0), 0, 1);
        shipExceptions.push({
          id:`EXC-SHP-${s.id}`,
          type:"Shipment Late Risk",
          shipmentId: s.id,
          lane: `${s.from} → ${s.to}`,
          skuId: s.sku,
          qty: s.qty,
          lateProb: round(lp,3),
          valueAtRisk: varUSD,
          riskScore: round(riskScore,2),
          why: buildWhy({kind:"ship", shipment:s, lateProb:lp, scenario:state.scenario, pinned:state.scenarioPinned}),
        });
      }
    }

    // Distribution exceptions (choke points)
    const distExceptions = [];
    for(const dc of dcs){
      const u = util[dc.id];
      if(u.utilization > 0.92 || u.risk > 0.62){
        distExceptions.push({
          id:`EXC-DC-${dc.id}`,
          type:"DC Throughput Choke Risk",
          dcId: dc.id,
          utilization: round(u.utilization,2),
          valueAtRisk: Math.round( (u.risk) * 120000 ), // proxy for expediting & service impact
          riskScore: round(clamp(u.risk,0,1),2),
          why: `Utilization is ${fmtNum(u.utilization*100,0)}% of effective capacity (capacity adjusted by scenario). Risk ramps sharply beyond ~85%.`,
        });
      }
    }

    // Combine and rank by value-at-risk (tie-break by riskScore)
    const all = invExceptions.concat(shipExceptions).concat(distExceptions);
    all.sort((a,b)=> (b.valueAtRisk - a.valueAtRisk) || (b.riskScore - a.riskScore));

    // KPIs
    const totalVar = all.reduce((s,x)=>s+x.valueAtRisk,0);
    const serviceRisk = clamp(sigmoid((totalVar/220000)-0.6), 0.03, 0.96);
    const avgUtil = Object.values(util).reduce((s,u)=>s+u.utilization,0) / dcs.length;
    const lateShipCount = shipExceptions.length;

    return {
      multipliers: m,
      util,
      exceptions: all,
      kpis: {
        valueAtRisk: totalVar,
        serviceRisk: serviceRisk,
        avgDcUtil: avgUtil,
        lateShipments: lateShipCount,
      }
    };
  }

  function buildWhy(ctx){
    if(ctx.kind==="inv"){
      const {dc, sku, doc, shortage, dcRisk, scenario, pinned} = ctx;
      const bits = [];
      bits.push(`DOC is ${round(doc,1)} days (risk increases below 7).`);
      if(shortage>0) bits.push(`Projected shortage ≈ ${fmtNum(shortage)} units over 7 days if inbound doesn’t land.`);
      if(dcRisk>0.5) bits.push(`DC utilization risk is elevated (${fmtNum(dcRisk*100,0)}%).`);
      if(scenario.dcOutage && pinned.outageDcId===dc.id) bits.push(`Scenario: DC outage reduces effective throughput and increases delay risk.`);
      if(scenario.demandSpike && pinned.spikeSkuId===sku.id) bits.push(`Scenario: demand spike on this SKU increases burn-rate.`);
      if(scenario.cyberDegraded) bits.push(`Scenario: cyber degraded mode adds planning friction (higher late/stockout risk).`);
      return bits.join(" ");
    }
    if(ctx.kind==="ship"){
      const {shipment, lateProb, scenario, pinned} = ctx;
      const bits = [];
      bits.push(`Late probability is ${fmtNum(lateProb*100,1)}% based on lane miles, carrier on-time, fuel drift, and scenario signals.`);
      if(scenario.dcOutage && (shipment.from===pinned.outageDcId || shipment.to===pinned.outageDcId)) bits.push(`Touches the outage DC (higher disruption risk).`);
      if(scenario.carrierDisruption && shipment.carrier===pinned.disruptedCarrierId) bits.push(`Carrier is disrupted (lower on-time).`);
      if(scenario.cyberDegraded) bits.push(`Cyber degraded mode increases handoffs and planning latency.`);
      return bits.join(" ");
    }
    return "";
  }

  // ---------- Action engine ----------
  function logAction(action){
    state.actionLog.unshift({
      ts: new Date().toISOString(),
      day: state.day,
      ...action,
    });
  }

  function canExecute(){
    if(state.scenario.cyberDegraded){
      return {ok:false, reason:"Cyber degraded mode: execution is restricted. Use Playbooks to generate a manual plan (simulated guardrail)."};
    }
    return {ok:true, reason:""};
  }

  function executeAction(action){
    const gate = canExecute();
    if(!gate.ok){
      toast("Execution blocked", gate.reason);
      logAction({type:"GUARDRAIL_BLOCK", detail: gate.reason});
      render(); // to reflect log
      return;
    }

    if(action.type==="REBALANCE_TRANSFER"){
      const {fromDcId, toDcId, skuId, qty, transitDays, transferCost, benefit} = action;
      if(qty<=0) return;
      // reduce source immediately
      state.inventory[fromDcId][skuId] = Math.max(0, state.inventory[fromDcId][skuId]-qty);
      // create transfer shipment
      const shipId = `SHP-XFER-${Math.floor(Math.random()*1e9)}`;
      const carrier = pickCarrierForTransfer();
      state.shipments.unshift({
        id: shipId,
        kind: "transfer",
        from: fromDcId,
        to: toDcId,
        laneId: null,
        miles: Math.max(200, Math.round(transitDays*520)),
        sku: skuId,
        qty,
        carrier,
        createdDay: state.day,
        etaDays: transitDays,
        baseTransitDays: transitDays,
        penalty: 6000,
        status: "in_transit",
        cost: Math.round(transferCost),
      });

      logAction({
        type:"REBALANCE_TRANSFER",
        detail:`Transferred ${fmtNum(qty)} units of ${skuId} from ${fromDcId} → ${toDcId} (ETA ${transitDays}d).`,
        meta:{fromDcId,toDcId,skuId,qty,transitDays,transferCost,benefit}
      });
      toast("Executed: Rebalance transfer", `Inventory updated immediately; transfer will arrive in ${transitDays} days.`);
      render();
      return;
    }

    if(action.type==="RETENDER"){
      const {shipmentId, newCarrierId, expectedTotal} = action;
      const s = state.shipments.find(x=>x.id===shipmentId);
      if(!s) return;
      const prev = s.carrier;
      s.carrier = newCarrierId;
      // update cost to recommended expected freight (keep it simple)
      const m = scenarioMultipliers();
      const quote = expectedTotalCostForRetender(s, newCarrierId, m);
      s.cost = quote.freight;
      // adjust ETA a bit: better carriers slightly reduce ETA
      s.etaDays = clamp(Math.round(s.etaDays*(prev===newCarrierId ? 1.0 : 0.92)), 0, 7);

      logAction({type:"RETENDER", detail:`Re-tendered ${shipmentId} from ${prev} → ${newCarrierId}. Expected total cost ≈ ${fmtUSD(quote.expectedTotal)}.`, meta:{shipmentId, prev, newCarrierId, quote}});
      toast("Executed: Re-tender", `Shipment ${shipmentId} moved to ${newCarrierId}.`);
      render();
      return;
    }

    if(action.type==="EXPEDITE_INBOUND"){
      const {dcId, skuId, addQty} = action;
      // create an inbound "expedite" that arrives fast
      const shipId = `SHP-EXP-${Math.floor(Math.random()*1e9)}`;
      const fromPlant = baseline.plants[Math.floor(Math.random()*baseline.plants.length)].id;
      const lane = baseline.lanes.find(l=>l.from===fromPlant && l.to===dcId) || baseline.lanes[0];
      const carrier = baseline.carriers[2].id; // choose a better carrier
      state.shipments.unshift({
        id: shipId,
        kind:"inbound",
        from: fromPlant,
        to: dcId,
        laneId: lane.id,
        sku: skuId,
        qty: addQty,
        carrier,
        createdDay: state.day,
        etaDays: 1,
        baseTransitDays: lane.transitDays,
        penalty: 9000,
        status:"in_transit",
        cost: Math.round(lane.miles*3.2),
      });
      logAction({type:"EXPEDITE_INBOUND", detail:`Expedited ${fmtNum(addQty)} units of ${skuId} to ${dcId} (ETA 1d).`, meta:{dcId, skuId, addQty}});
      toast("Executed: Expedite", `Inbound expedite created; will arrive tomorrow (simulated).`);
      render();
      return;
    }

    if(action.type==="REROUTE_OVERFLOW"){
      const {dcId} = action;
      // Temporary throughput relief (labor/slotting/overflow trailers): boosts effective capacity for 3 days.
      state.overflowBoost[dcId] = 3;
      logAction({type:"REROUTE_OVERFLOW", detail:`Activated overflow plan for ${dcId} (temporary throughput relief).`, meta:{dcId}});
      toast("Executed: Overflow plan", `Throughput risk will reduce for ~3 days (simulated).`);
      render();
      return;
    }

    logAction({type:"UNKNOWN_ACTION", detail:`Unknown action type: ${action.type}`, meta:action});
    render();
  }

  function pickCarrierForTransfer(){
    // choose a carrier with capacity; if disrupted, avoid it
    const disrupted = state.scenarioPinned.disruptedCarrierId;
    const pool = baseline.carriers.filter(c=> c.id !== disrupted);
    pool.sort((a,b)=> (b.onTime - a.onTime));
    return (pool[0]||baseline.carriers[0]).id;
  }

  // ---------- Simulation engine (live-feeling) ----------
  function tick(){
    state.day += 1;

    // consume inventory based on demand
    // decay overflow boosts
    for(const k of Object.keys(state.overflowBoost)){
      state.overflowBoost[k] = Math.max(0, (state.overflowBoost[k]||0) - 1);
      if(state.overflowBoost[k]===0) delete state.overflowBoost[k];
    }

    const derived = deriveKpisAndExceptions();
    const m = derived.multipliers;
    for(const dc of baseline.dcs){
      for(const sku of baseline.skus){
        const base = baseline.demand[dc.id][sku.id];
        const mult = m.demandMult[sku.id] || 1.0;
        const cyber = state.scenario.cyberDegraded ? 1.05 : 1.0;
        const d = Math.round(base*mult*cyber);
        state.inventory[dc.id][sku.id] = Math.max(0, state.inventory[dc.id][sku.id]-d);
      }
    }

    // advance shipments; deliver if eta reaches 0
    for(const s of state.shipments){
      if(s.status==="delivered") continue;
      s.etaDays = Math.max(0, (s.etaDays||0) - 1);
      if(s.etaDays===0){
        s.status = "delivered";
        if(s.to && state.inventory[s.to] && state.inventory[s.to][s.sku]!=null){
          state.inventory[s.to][s.sku] += s.qty;
        }
        logAction({type:"SHIPMENT_DELIVERED", detail:`Delivered ${s.id} to ${s.to} (${fmtNum(s.qty)} units of ${s.sku}).`, meta:{shipmentId:s.id}});
      }
    }

    // fuel index drift
    const last = state.fuelIndex[state.fuelIndex.length-1].index;
    const drift = (Math.random()*0.018 - 0.009);
    const next = clamp(last*(1+drift), 0.85, 1.25);
    state.fuelIndex.push({day: state.day, index: round(next,3)});
    if(state.fuelIndex.length>28) state.fuelIndex.shift();

    render(); // updates KPIs/exceptions/charts
  }

  function startSim(){
    if(state.simRunning) return;
    state.simRunning = true;
    state.simTimer = setInterval(tick, 1200);
    toast("Simulation running", "State updates every ~1.2s (inventory burn, shipment arrivals, fuel drift).");
    render();
  }
  function stopSim(){
    state.simRunning = false;
    if(state.simTimer) clearInterval(state.simTimer);
    state.simTimer = null;
    toast("Simulation stopped", "State is paused; you can still execute actions.");
    render();
  }

  // ---------- Routing & Rendering ----------
  const routes = {
    "/exec": renderExec,
    "/control": renderControlTower,
    "/network": renderNetwork,
    "/transport": renderTransportation,
    "/distribution": renderDistribution,
    "/inventory": renderInventory,
    "/scenario": renderScenario,
    "/playbooks": renderPlaybooks,
    "/data": renderData,
  };

  function currentPath(){
    const h = location.hash || "#/exec";
    return h.replace("#","") || "/exec";
  }

  function setActiveNav(){
    const p = currentPath();
    document.querySelectorAll(".nav a").forEach(a=>{
      a.classList.toggle("active", a.getAttribute("href")==="#"+p);
    });
  }

  function setScenarioPills(){
    const el = document.getElementById("scenarioPills");
    const pills = [];
    const map = [
      ["dcOutage","DC outage"],
      ["carrierDisruption","Carrier disruption"],
      ["demandSpike","Demand spike"],
      ["cyberDegraded","Cyber degraded mode"],
    ];
    for(const [k,label] of map){
      pills.push(`<span class="pill ${state.scenario[k]?"on":""}">${label}</span>`);
    }
    el.innerHTML = pills.join("");
  }

  function render(){
    setActiveNav();
    setScenarioPills();
    document.getElementById("clock").textContent = `Day ${state.day} • ${new Date().toLocaleString()}`;

    const p = currentPath();
    state.ui.lastRoute = "#"+p;
    const fn = routes[p] || renderExec;
    fn();
  }

  // ---------- Page: Executive Brief ----------
  function renderExec(){
    const derived = deriveKpisAndExceptions();
    const top = derived.exceptions.slice(0,5);

    // quick insights to power “exec Q&A cards”
    const topInv = derived.exceptions.find(x=>x.type==="Inventory Coverage Risk");
    const topDc = derived.exceptions.find(x=>x.type==="DC Throughput Choke Risk");
    const topShip = derived.exceptions.find(x=>x.type==="Shipment Late Risk");

    const app = document.getElementById("app");
    app.innerHTML = `
      <div class="panel">
        <div class="split">
          <div>
            <h2>Executive Brief</h2>
            <div class="sub">Exec-facing Q&A cards: “why” + one-click actions. Designed to replace an opening slide.</div>
          </div>
          <div class="controls">
            <span class="badge info">Synthetic state updates in-browser</span>
            <span class="badge ${derived.kpis.serviceRisk>0.66?"bad":(derived.kpis.serviceRisk>0.45?"warn":"ok")}">
              Service Risk ${fmtNum(derived.kpis.serviceRisk*100,0)}%
            </span>
            <span class="badge ${derived.kpis.avgDcUtil>0.9?"warn":"ok"}">Avg DC Util ${fmtNum(derived.kpis.avgDcUtil*100,0)}%</span>
            <span class="badge ${derived.kpis.lateShipments>8?"warn":"ok"}">At-risk shipments ${derived.kpis.lateShipments}</span>
          </div>
        </div>

        <div class="cards" style="margin-top:12px">
          ${qaCard(
            "Where will we miss service next — and what’s the cheapest prevention?",
            topInv ? `Top risk: ${lookupDc(topInv.dcId).name} • ${lookupSku(topInv.skuId).name}. ${topInv.why}` : "No material inventory exceptions (synthetic).",
            topInv ? [
              {label:"Open Control Tower", route:"#/control"},
              {label:"Expedite (1 day)", action: ()=> executeAction({type:"EXPEDITE_INBOUND", dcId: topInv.dcId, skuId: topInv.skuId, addQty: 1200})}
            ] : [{label:"Open Control Tower", route:"#/control"}]
          )}

          ${qaCard(
            "What inventory should sit where to avoid expediting and stockouts?",
            `Rebalancing ranks transfers by net value = benefit − transfer cost (incl. transit days).`,
            [
              {label:"Open Inventory", route:"#/inventory"},
              {label:"Run top transfer", action: ()=> runTopRebalanceAndExecute()}
            ]
          )}

          ${qaCard(
            "Which DC constraints will break the network next week?",
            topDc ? `Most constrained: ${lookupDc(topDc.dcId).name}. ${topDc.why}` : "No DC choke points detected (synthetic).",
            [
              {label:"Open Distribution", route:"#/distribution"},
              {label:"Activate overflow", action: ()=> topDc && executeAction({type:"REROUTE_OVERFLOW", dcId: topDc.dcId})}
            ]
          )}

          ${qaCard(
            "Which lanes/carriers are costing us most — and what to change?",
            topShip ? `Highest late exposure: ${topShip.shipmentId}. ${topShip.why}` : "No critical shipment late risks (synthetic).",
            [
              {label:"Open Transportation", route:"#/transport"},
              {label:"Retender best option", action: ()=> topShip && retenderBest(topShip.shipmentId)}
            ]
          )}

          ${qaCard(
            "In a disruption, what’s the degraded-mode plan?",
            state.scenario.cyberDegraded
              ? `Cyber degraded mode is ON. Execution guardrails restrict automation; use Playbooks to produce a manual plan and audit trail.`
              : `Turn on “Cyber degraded mode” to show the playbooks + guardrails and how the control tower shifts.`,
            [
              {label:"Open Scenario Simulator", route:"#/scenario"},
              {label: state.scenario.cyberDegraded ? "View Playbooks" : "Enable cyber mode", action: ()=> {
                if(state.scenario.cyberDegraded){ location.hash="#/playbooks"; }
                else { state.scenario.cyberDegraded=true; toast("Scenario enabled","Cyber degraded mode is ON (execution restricted)."); render(); }
              }}
            ]
          )}

          ${qaCard(
            "What changed and why? (audit trail)",
            `Download a JSON snapshot of current state + action log to support “audit trail” storytelling.`,
            [
              {label:"Download snapshot", action: ()=> downloadSnapshot()},
              {label:"Open Data Explorer", route:"#/data"}
            ]
          )}
        </div>

        <hr class="sep" />

        <div class="panel" style="background:rgba(0,0,0,.12); border-radius:14px; border:1px solid var(--line); box-shadow:none;">
          <h3>Top exceptions right now</h3>
          <div class="sub">Ranked by $ value-at-risk (VaR) then risk score. Click through in Control Tower to approve & execute actions.</div>
          ${exceptionsTable(top)}
        </div>
      </div>
    `;

    wireCardButtons(app);
  }

  function qaCard(question, whyText, actions){
    const actionsHtml = (actions||[]).map((a,i)=>{
      if(a.route) return `<button class="btn btn-small" data-route="${a.route}">${escapeHtml(a.label)}</button>`;
      return `<button class="btn btn-small" data-action="cardAction-${Math.random().toString(16).slice(2)}">${escapeHtml(a.label)}</button>`;
    }).join(" ");
    // store handlers later by scanning buttons
    const handlers = (actions||[]).filter(x=>x.action).map(x=>x.action);
    return `
      <div class="card" data-handlers="${handlers.length}">
        <div class="label">${escapeHtml(question)}</div>
        <div class="hint">${escapeHtml(whyText)}</div>
        <div class="row" style="margin-top:auto;">
          <div class="controls">
            ${actionsHtml}
          </div>
        </div>
        <div class="smallNote">“Why” is explainable; actions update state immediately.</div>
      </div>
    `;
  }

  function wireCardButtons(container){
    // route buttons
    container.querySelectorAll("[data-route]").forEach(btn=>{
      btn.addEventListener("click", ()=>{ location.hash = btn.getAttribute("data-route"); });
    });

    // action buttons: match by label text + nearest card and rerun mapping
    // Simpler: attach known actions by scanning in order within each card
    const cards = Array.from(container.querySelectorAll(".card"));
    const mapping = [
      // Card 0 actions
      [
        null,
        ()=> { const d=deriveKpisAndExceptions(); const topInv=d.exceptions.find(x=>x.type==="Inventory Coverage Risk"); if(topInv) executeAction({type:"EXPEDITE_INBOUND", dcId: topInv.dcId, skuId: topInv.skuId, addQty: 1200}); }
      ],
      // Card 1 actions
      [
        null,
        ()=> runTopRebalanceAndExecute()
      ],
      // Card 2 actions
      [
        null,
        ()=> { const d=deriveKpisAndExceptions(); const topDc=d.exceptions.find(x=>x.type==="DC Throughput Choke Risk"); if(topDc) executeAction({type:"REROUTE_OVERFLOW", dcId: topDc.dcId}); }
      ],
      // Card 3 actions
      [
        null,
        ()=> { const d=deriveKpisAndExceptions(); const topShip=d.exceptions.find(x=>x.type==="Shipment Late Risk"); if(topShip) retenderBest(topShip.shipmentId); }
      ],
      // Card 4 actions
      [
        null,
        ()=> { if(state.scenario.cyberDegraded) location.hash="#/playbooks"; else { state.scenario.cyberDegraded=true; toast("Scenario enabled","Cyber degraded mode is ON (execution restricted)."); render(); } }
      ],
      // Card 5 actions
      [
        ()=> downloadSnapshot(),
        null
      ],
    ];

    cards.forEach((card, idx)=>{
      const actionBtns = Array.from(card.querySelectorAll("button")).filter(b=>!b.hasAttribute("data-route"));
      actionBtns.forEach((btn, j)=>{
        const fn = (mapping[idx]||[])[j];
        if(fn) btn.addEventListener("click", fn);
      });
    });
  }

  // ---------- Page: Control Tower ----------
  function renderControlTower(){
    const derived = deriveKpisAndExceptions();
    const exceptions = derived.exceptions.slice(0,20);
    const selectedId = state.ui.selectedExceptionId || (exceptions[0] && exceptions[0].id);
    state.ui.selectedExceptionId = selectedId;

    const sel = exceptions.find(x=>x.id===selectedId) || exceptions[0];

    const app = document.getElementById("app");
    app.innerHTML = `
      <div class="grid">
        <div class="panel">
          <div class="split">
            <div>
              <h2>Control Tower</h2>
              <div class="sub">Top exceptions ranked by $ value-at-risk and risk score. Click an exception → recommended actions → approve & execute.</div>
            </div>
            <div class="controls">
              <span class="badge info">VaR ${fmtUSD(derived.kpis.valueAtRisk)}</span>
              <span class="badge ${derived.kpis.serviceRisk>0.66?"bad":(derived.kpis.serviceRisk>0.45?"warn":"ok")}">Service Risk ${fmtNum(derived.kpis.serviceRisk*100,0)}%</span>
            </div>
          </div>
          ${controlTable(exceptions, selectedId)}
        </div>

        <div class="panel">
          <h2>Exception Detail</h2>
          <div class="sub">Explainable “why” + recommended action set. Execution updates state immediately and logs an audit trail.</div>

          ${sel ? exceptionDetail(sel, derived) : `<div class="callout">No exceptions found.</div>`}

          <hr class="sep" />
          <h3>Action Log (most recent)</h3>
          ${actionLogTable(state.actionLog.slice(0,10))}
        </div>
      </div>
    `;

    // wire exception selection
    app.querySelectorAll("[data-exc]").forEach(row=>{
      row.addEventListener("click", ()=>{
        state.ui.selectedExceptionId = row.getAttribute("data-exc");
        render();
      });
    });

    // wire actions
    app.querySelectorAll("[data-approve]").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        const payload = JSON.parse(btn.getAttribute("data-approve"));
        executeAction(payload);
      });
    });

    // wire "go to module" deep links
    app.querySelectorAll("[data-route]").forEach(btn=>{
      btn.addEventListener("click", ()=> location.hash = btn.getAttribute("data-route"));
    });
  }

  function controlTable(exceptions, selectedId){
    const rows = exceptions.map(e=>{
      const active = e.id===selectedId ? `style="background: rgba(255,255,255,.05)"` : "";
      const badge = e.riskScore>0.78 ? "bad" : (e.riskScore>0.62 ? "warn" : "ok");
      const title = e.type;
      const ref = e.type==="Shipment Late Risk" ? e.shipmentId : (e.dcId ? `${e.dcId}${e.skuId?(" • "+e.skuId):""}` : "");
      return `
        <tr data-exc="${escapeHtml(e.id)}" ${active}>
          <td><span class="badge ${badge}">${fmtNum(e.riskScore*100,0)}%</span></td>
          <td><div style="font-weight:900">${escapeHtml(title)}</div><div class="smallNote mono">${escapeHtml(ref)}</div></td>
          <td class="mono">${fmtUSD(e.valueAtRisk)}</td>
          <td class="mono">${escapeHtml(e.doc!=null? (fmtNum(e.doc,1)+"d DOC") : (e.utilization!=null?(fmtNum(e.utilization*100,0)+"% util"):(e.lateProb!=null?(fmtNum(e.lateProb*100,1)+"% late"):"—")))}</td>
        </tr>
      `;
    }).join("");

    return `
      <table class="table">
        <thead><tr>
          <th>Risk</th><th>Exception</th><th>Value-at-risk</th><th>Signal</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  function exceptionDetail(e, derived){
    const badge = e.riskScore>0.78 ? "bad" : (e.riskScore>0.62 ? "warn" : "ok");
    const why = e.why || "—";
    const actions = recommendedActionsForException(e, derived);
    const blocked = state.scenario.cyberDegraded;

    const actionHtml = actions.map(a=>{
      const btnCls = blocked ? "btn btn-small btn-danger" : "btn btn-small";
      const hint = blocked ? ` (blocked in cyber degraded mode)` : "";
      return `
        <div class="panel" style="padding:12px; box-shadow:none; background:rgba(0,0,0,.12)">
          <div class="split">
            <div>
              <div style="font-weight:900">${escapeHtml(a.label)}</div>
              <div class="smallNote">${escapeHtml(a.why)}</div>
              <div class="smallNote mono">Impact: ${escapeHtml(a.impact)}</div>
            </div>
            <div class="controls">
              <button class="${btnCls}" data-approve='${JSON.stringify(a.payload)}'>Approve & execute${hint}</button>
              ${a.route ? `<button class="btn btn-small btn-ghost" data-route="${a.route}">Open module</button>`:""}
            </div>
          </div>
        </div>
      `;
    }).join("");

    const ref = e.type==="Shipment Late Risk" ? e.shipmentId : (e.dcId ? `${lookupDc(e.dcId).name}${e.skuId?(" • "+lookupSku(e.skuId).name):""}` : "");
    return `
      <div class="kv">
        <div class="item"><div class="k">Exception</div><div class="v">${escapeHtml(e.type)}</div></div>
        <div class="item"><div class="k">Value-at-risk</div><div class="v">${fmtUSD(e.valueAtRisk)}</div></div>
        <div class="item"><div class="k">Risk score</div><div class="v"><span class="badge ${badge}">${fmtNum(e.riskScore*100,0)}%</span></div></div>
        <div class="item"><div class="k">Context</div><div class="v mono">${escapeHtml(ref)}</div></div>
      </div>
      <hr class="sep" />
      <div class="callout"><b>Why:</b> ${escapeHtml(why)}</div>
      <hr class="sep" />
      <h3>Recommended actions</h3>
      ${actionHtml || `<div class="callout">No actions available.</div>`}
    `;
  }

  function recommendedActionsForException(e, derived){
    const m = derived.multipliers;
    const actions = [];

    if(e.type==="Inventory Coverage Risk"){
      // 1) rebalancing (if any positive net value transfer exists)
      const best = getTopRebalanceForSku(e.skuId);
      if(best){
        actions.push({
          label: `Rebalance: transfer ${fmtNum(best.qty)} units (${lookupSku(best.skuId).name})`,
          why: `Highest net value transfer for this SKU (benefit − transfer cost). Includes transit days.`,
          impact: `Net value ≈ ${fmtUSD(best.netValue)} • ETA ${best.transitDays}d • reduces stockout exposure at ${lookupDc(best.toDcId).id}`,
          payload: {type:"REBALANCE_TRANSFER", ...best},
          route: "#/inventory"
        });
      }
      // 2) expedite inbound
      actions.push({
        label: "Expedite inbound (1 day)",
        why: "Fastest prevention when stockout risk is imminent; increases on-hand quickly (simulated).",
        impact: `Adds ~1,200 units to ${lookupDc(e.dcId).id} next day.`,
        payload: {type:"EXPEDITE_INBOUND", dcId: e.dcId, skuId: e.skuId, addQty: 1200},
        route: "#/transport"
      });
      return actions;
    }

    if(e.type==="Shipment Late Risk"){
      actions.push({
        label: "Re-tender to lowest expected total cost",
        why: "Expected total cost = freight + (late probability × penalty). Picks cheapest risk-adjusted option.",
        impact: "Carrier swap updates shipment cost/ETA and recomputes late probability.",
        payload: {type:"RETENDER", shipmentId: e.shipmentId, ...bestRetenderQuote(e.shipmentId)},
        route: "#/transport"
      });
      return actions;
    }

    if(e.type==="DC Throughput Choke Risk"){
      actions.push({
        label: "Activate overflow / reroute plan",
        why: "Temporary throughput relief (labor/slotting/overflow trailer yard). Reduces choke risk.",
        impact: "Simulated capacity relief (shown via risk recompute).",
        payload: {type:"REROUTE_OVERFLOW", dcId: e.dcId},
        route: "#/distribution"
      });
      // also propose rebalancing for the most stressed SKU at that DC
      const skuId = worstSkuAtDc(e.dcId);
      const best = skuId ? getTopRebalanceForSku(skuId) : null;
      if(best){
        actions.unshift({
          label: `Shift volume away: rebalance ${fmtNum(best.qty)} units of ${lookupSku(best.skuId).name}`,
          why: "Reduce outbound pressure by shifting allocation to less-utilized DCs.",
          impact: `Net value ≈ ${fmtUSD(best.netValue)} • ETA ${best.transitDays}d`,
          payload: {type:"REBALANCE_TRANSFER", ...best},
          route: "#/inventory"
        });
      }
      return actions;
    }
    return actions;
  }

  function worstSkuAtDc(dcId){
    // choose SKU with lowest DOC
    const derived = deriveKpisAndExceptions();
    const inv = derived.exceptions.filter(x=>x.type==="Inventory Coverage Risk" && x.dcId===dcId);
    if(inv.length) return inv.sort((a,b)=>a.doc-b.doc)[0].skuId;
    return baseline.skus[0].id;
  }

  // ---------- Page: Network ----------
  function renderNetwork(){
    fixLeafletIcons();
    const derived = deriveKpisAndExceptions();
    const dcs = baseline.dcs;
    const plants = baseline.plants;

    // compute a simple node risk overlay:
    // - DC risk = utilization risk + inventory risk (max)
    const invRisks = {};
    for(const e of derived.exceptions){
      if(e.type==="Inventory Coverage Risk"){
        invRisks[e.dcId] = Math.max(invRisks[e.dcId]||0, e.riskScore);
      }
    }

    const nodeRisk = {};
    for(const dc of dcs){
      const u = derived.util[dc.id];
      const inv = invRisks[dc.id]||0;
      nodeRisk[dc.id] = clamp(0.55*(u?u.risk:0) + 0.45*inv, 0, 1);
    }
    for(const p of plants){
      nodeRisk[p.id] = 0.18; // plants are generally stable (demo)
    }

    const app = document.getElementById("app");
    app.innerHTML = `
      <div class="panel">
        <div class="split">
          <div>
            <h2>Network</h2>
            <div class="sub">Synthetic but realistic US geo scatter of plants/DCs with a simple risk overlay.</div>
          </div>
          <div class="controls">
            <span class="badge ${state.scenario.dcOutage?"warn":"ok"}">Outage DC: <span class="mono">${escapeHtml(state.scenarioPinned.outageDcId||"—")}</span></span>
            <span class="badge ${state.scenario.carrierDisruption?"warn":"ok"}">Disrupted carrier: <span class="mono">${escapeHtml(state.scenarioPinned.disruptedCarrierId||"—")}</span></span>
            <span class="badge ${state.scenario.demandSpike?"warn":"ok"}">Spike SKU: <span class="mono">${escapeHtml(state.scenarioPinned.spikeSkuId||"—")}</span></span>
          </div>
        </div>

        <div class="twoCol" style="margin-top:12px;">
          <div>
            <div id="map"></div>
            <div class="smallNote" style="margin-top:8px;">Tip: click a marker to see local risk drivers and jump to the relevant module.</div>
          </div>
          <div>
            <div class="panel" style="box-shadow:none; background:rgba(0,0,0,.12)">
              <h3>Legend</h3>
              <div class="smallNote">
                <div><span class="badge ok">Low</span> <span class="badge warn">Medium</span> <span class="badge bad">High</span></div>
                <div style="margin-top:8px;">Risk overlay combines:</div>
                <ul>
                  <li>DC throughput utilization risk (Distribution)</li>
                  <li>Inventory days-of-cover risk by SKU (Inventory)</li>
                </ul>
                <div class="callout">This is intentionally simple but explainable: it makes the network feel “real” and ties back to actions.</div>
              </div>
            </div>

            <div class="panel" style="box-shadow:none; background:rgba(0,0,0,.12); margin-top:12px;">
              <h3>Quick jumps</h3>
              <div class="controls">
                <button class="btn btn-small" data-route="#/control">Control Tower</button>
                <button class="btn btn-small" data-route="#/distribution">Distribution</button>
                <button class="btn btn-small" data-route="#/inventory">Inventory</button>
                <button class="btn btn-small" data-route="#/transport">Transportation</button>
              </div>
              <hr class="sep" />
              <h3>Most at-risk DCs</h3>
              ${riskDcTable(nodeRisk)}
            </div>
          </div>
        </div>
      </div>
    `;

    app.querySelectorAll("[data-route]").forEach(b=> b.addEventListener("click", ()=> location.hash = b.getAttribute("data-route")));

    // build map after DOM inject
    setTimeout(()=> buildMap(nodeRisk, invRisks, derived), 0);
  }

  function riskDcTable(nodeRisk){
    const dcs = baseline.dcs.slice();
    dcs.sort((a,b)=>(nodeRisk[b.id]-nodeRisk[a.id]));
    const rows = dcs.slice(0,6).map(dc=>{
      const r = nodeRisk[dc.id]||0;
      const badge = r>0.75?"bad":(r>0.55?"warn":"ok");
      return `<tr><td>${escapeHtml(dc.name)}</td><td><span class="badge ${badge}">${fmtNum(r*100,0)}%</span></td><td class="mono">${escapeHtml(dc.id)}</td></tr>`;
    }).join("");
    return `<table class="table"><thead><tr><th>DC</th><th>Risk</th><th>ID</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  function buildMap(nodeRisk, invRisks, derived){
    const mapEl = document.getElementById("map");
    if(!mapEl) return;

    // avoid duplicate maps on re-render
    if(state.ui.lastMap){
      try{ state.ui.lastMap.remove(); }catch(e){}
      state.ui.lastMap = null;
    }

    const map = L.map("map", {zoomControl:true, scrollWheelZoom:false}).setView([39.5, -98.35], 4);
    state.ui.lastMap = map;

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 10,
      attribution: "&copy; OpenStreetMap contributors"
    }).addTo(map);

    function colorForRisk(r){
      if(r>0.75) return "#ff6b6b";
      if(r>0.55) return "#ffcc66";
      return "#3ddc97";
    }

    function popupForNode(n){
      const r = nodeRisk[n.id]||0;
      const badge = r>0.75?"High":(r>0.55?"Medium":"Low");
      const u = derived.util[n.id];
      const inv = invRisks[n.id]||0;
      const pieces = [];
      if(n.type==="dc"){
        pieces.push(`Util risk: ${fmtNum((u?u.risk:0)*100,0)}% • Util: ${fmtNum((u?u.utilization:0)*100,0)}%`);
        pieces.push(`Inventory risk: ${fmtNum(inv*100,0)}%`);
      }else{
        pieces.push("Plant node (baseline-stable in demo).");
      }
      pieces.push(`ID: ${n.id}`);

      const jump = n.type==="dc"
        ? `<div style="margin-top:8px; display:flex; gap:6px; flex-wrap:wrap;">
             <button onclick="location.hash='#/inventory'" style="cursor:pointer; padding:6px 8px; border-radius:10px; border:1px solid rgba(255,255,255,.2); background:rgba(255,255,255,.06); color:#e8ecff;">Inventory</button>
             <button onclick="location.hash='#/distribution'" style="cursor:pointer; padding:6px 8px; border-radius:10px; border:1px solid rgba(255,255,255,.2); background:rgba(255,255,255,.06); color:#e8ecff;">Distribution</button>
             <button onclick="location.hash='#/control'" style="cursor:pointer; padding:6px 8px; border-radius:10px; border:1px solid rgba(255,255,255,.2); background:rgba(255,255,255,.06); color:#e8ecff;">Control Tower</button>
           </div>`
        : `<div style="margin-top:8px;"><button onclick="location.hash='#/control'" style="cursor:pointer; padding:6px 8px; border-radius:10px; border:1px solid rgba(255,255,255,.2); background:rgba(255,255,255,.06); color:#e8ecff;">Control Tower</button></div>`;

      return `<div style="font-family: ui-sans-serif, system-ui; color:#e8ecff;">
        <div style="font-weight:900; margin-bottom:4px;">${escapeHtml(n.name)}</div>
        <div style="opacity:.85;">Risk: <b>${badge}</b> (${fmtNum(r*100,0)}%)</div>
        <div style="opacity:.85; margin-top:4px;">${escapeHtml(pieces.join(" • "))}</div>
        ${jump}
      </div>`;
    }

    const nodes = baseline.nodes;
    for(const n of nodes){
      const r = nodeRisk[n.id]||0;
      const c = colorForRisk(r);
      const radius = n.type==="dc" ? 14 : 10;
      const marker = L.circleMarker([n.lat, n.lon], {
        radius,
        color: c,
        weight: 2,
        fillColor: c,
        fillOpacity: 0.55,
      }).addTo(map);

      marker.bindPopup(popupForNode(n), {maxWidth: 320});
      if(state.scenario.dcOutage && n.id===state.scenarioPinned.outageDcId){
        marker.setStyle({weight:3, dashArray:"4 3", fillOpacity:0.8});
      }
    }
  }

  // ---------- Page: Transportation ----------
  function renderTransportation(){
    const derived = deriveKpisAndExceptions();
    const m = derived.multipliers;
    const carriers = baseline.carriers;
    const shipments = state.shipments.filter(s=>s.status!=="delivered").slice(0,40);

    // Carrier scorecard with scenario-adjusted on-time
    const score = carriers.map(c=>{
      const onTimeAdj = clamp(c.onTime + (m.carrierOnTimeDelta[c.id]||0), 0.65, 0.98);
      const status = (state.scenario.carrierDisruption && c.id===state.scenarioPinned.disruptedCarrierId) ? "Disrupted" : "Normal";
      return {
        id:c.id, name:c.name,
        onTimeAdj,
        costIndex:c.costIndex,
        status,
      };
    });

    // At-risk shipments list with late probability display from same model
    const atRisk = shipments
      .map(s=>({s, lateProb: computeLateProbability(s, m)}))
      .sort((a,b)=> b.lateProb - a.lateProb)
      .slice(0,12);

    const app = document.getElementById("app");
    app.innerHTML = `
      <div class="grid">
        <div class="panel">
          <div class="split">
            <div>
              <h2>Transportation</h2>
              <div class="sub">Carrier scorecard, fuel index drift, and at-risk shipments. Re-tender uses: expected total cost = freight + (late probability × penalty).</div>
            </div>
            <div class="controls">
              <span class="badge info">Fuel drift: ${fmtNum(getFuelDrift()*100,2)}%</span>
              <span class="badge ${state.scenario.carrierDisruption?"warn":"ok"}">Carrier disruption: ${state.scenario.carrierDisruption?"ON":"OFF"}</span>
              <span class="badge ${state.scenario.cyberDegraded?"warn":"ok"}">Execution: ${state.scenario.cyberDegraded?"Restricted":"Enabled"}</span>
            </div>
          </div>

          <div class="twoCol" style="margin-top:12px;">
            <div class="panel" style="box-shadow:none; background:rgba(0,0,0,.12)">
              <h3>Carrier scorecard</h3>
              ${carrierTable(score)}
            </div>
            <div class="panel" style="box-shadow:none; background:rgba(0,0,0,.12)">
              <h3>Fuel index drift (synthetic)</h3>
              <canvas id="fuelChart" height="170"></canvas>
              <div class="smallNote">Fuel drift feeds late-probability volatility and cost pressure (in a simple explainable way).</div>
            </div>
          </div>
        </div>

        <div class="panel">
          <h2>At-risk shipments</h2>
          <div class="sub">Late probability display is computed from the same model used in re-tender (no mismatch).</div>
          ${atRiskTable(atRisk)}
          <hr class="sep" />
          <h3>Re-tender detail</h3>
          <div class="callout">Click “Recommend” to compute expected total cost by carrier; click “Approve & execute” to retender.</div>
          <div id="retenderBox" class="panel" style="box-shadow:none; background:rgba(0,0,0,.12)">${retenderEmpty()}</div>
        </div>
      </div>
    `;

    // chart
    drawFuelChart();

    // wire recommend buttons
    app.querySelectorAll("[data-recommend]").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        const sid = btn.getAttribute("data-recommend");
        renderRetenderBox(sid);
      });
    });

    // wire approve retender
    app.querySelectorAll("[data-approve-retender]").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        const payload = JSON.parse(btn.getAttribute("data-approve-retender"));
        executeAction(payload);
      });
    });
  }

  function carrierTable(rows){
    const body = rows.map(r=>{
      const badge = r.onTimeAdj>0.91 ? "ok" : (r.onTimeAdj>0.87 ? "warn":"bad");
      const st = r.status==="Disrupted" ? "warn" : "ok";
      return `<tr>
        <td><div style="font-weight:900">${escapeHtml(r.name)}</div><div class="mono smallNote">${escapeHtml(r.id)}</div></td>
        <td><span class="badge ${badge}">${fmtNum(r.onTimeAdj*100,1)}%</span></td>
        <td class="mono">${fmtNum(r.costIndex,2)}×</td>
        <td><span class="badge ${st}">${escapeHtml(r.status)}</span></td>
      </tr>`;
    }).join("");
    return `<table class="table">
      <thead><tr><th>Carrier</th><th>On-time</th><th>Cost index</th><th>Status</th></tr></thead>
      <tbody>${body}</tbody>
    </table>`;
  }

  function atRiskTable(rows){
    const body = rows.map(({s, lateProb})=>{
      const badge = lateProb>0.70?"bad":(lateProb>0.50?"warn":"ok");
      const lane = `${s.from} → ${s.to}`;
      const sku = lookupSku(s.sku).name;
      return `<tr>
        <td class="mono">${escapeHtml(s.id)}</td>
        <td>${escapeHtml(lane)}<div class="smallNote">${escapeHtml(sku)} • Qty ${fmtNum(s.qty)}</div></td>
        <td><span class="badge ${badge}">${fmtNum(lateProb*100,1)}%</span></td>
        <td class="mono">${fmtUSD(s.penalty||7000)}</td>
        <td><button class="btn btn-small btn-ghost" data-recommend="${escapeHtml(s.id)}">Recommend</button></td>
      </tr>`;
    }).join("");
    return `<table class="table">
      <thead><tr><th>Shipment</th><th>Lane</th><th>Late probability</th><th>Penalty</th><th></th></tr></thead>
      <tbody>${body}</tbody>
    </table>`;
  }

  function retenderEmpty(){
    return `<div class="smallNote">No shipment selected yet.</div>`;
  }

  function renderRetenderBox(shipmentId){
    const box = document.getElementById("retenderBox");
    if(!box) return;
    const s = state.shipments.find(x=>x.id===shipmentId);
    if(!s){ box.innerHTML = retenderEmpty(); return; }

    const m = scenarioMultipliers();
    const carriers = baseline.carriers;
    const quotes = carriers.map(c=>{
      const q = expectedTotalCostForRetender(s, c.id, m);
      return {carrierId:c.id, carrierName:c.name, ...q};
    }).sort((a,b)=> a.expectedTotal - b.expectedTotal);

    const best = quotes[0];
    const current = quotes.find(q=>q.carrierId===s.carrier);

    const rows = quotes.map(q=>{
      const bestBadge = q.carrierId===best.carrierId ? `<span class="badge ok">Best</span>`:"";
      return `<tr>
        <td><div style="font-weight:900">${escapeHtml(q.carrierName)}</div><div class="mono smallNote">${escapeHtml(q.carrierId)}</div></td>
        <td class="mono">${fmtUSD(q.freight)}</td>
        <td><span class="badge ${q.lateProb>0.6?"warn":"ok"}">${fmtNum(q.lateProb*100,1)}%</span></td>
        <td class="mono">${fmtUSD(q.expectedTotal)}</td>
        <td>${bestBadge}</td>
      </tr>`;
    }).join("");

    const payload = {type:"RETENDER", shipmentId, newCarrierId: best.carrierId, expectedTotal: best.expectedTotal};

    box.innerHTML = `
      <div class="split">
        <div>
          <div class="big">Shipment <span class="mono">${escapeHtml(shipmentId)}</span></div>
          <div class="smallNote">Current carrier: <span class="mono">${escapeHtml(s.carrier)}</span> • Current expected total ≈ <b>${fmtUSD(current.expectedTotal)}</b></div>
          <div class="smallNote">Rule: expected total cost = freight + (late probability × penalty).</div>
        </div>
        <div class="controls">
          <button class="btn btn-small" data-approve-retender='${JSON.stringify(payload)}'>Approve & execute (retender)</button>
        </div>
      </div>
      <hr class="sep" />
      <table class="table">
        <thead><tr><th>Carrier</th><th>Freight</th><th>Late prob</th><th>Expected total</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="smallNote">Note: late probability shown here is computed by the same model used in the ranking (no display mismatch).</div>
    `;

    box.querySelectorAll("[data-approve-retender]").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        const payload = JSON.parse(btn.getAttribute("data-approve-retender"));
        executeAction(payload);
      });
    });
  }

  function bestRetenderQuote(shipmentId){
    const s = state.shipments.find(x=>x.id===shipmentId);
    if(!s) return {newCarrierId: baseline.carriers[0].id, expectedTotal: 0};
    const m = scenarioMultipliers();
    const quotes = baseline.carriers.map(c=>{
      const q = expectedTotalCostForRetender(s, c.id, m);
      return {carrierId:c.id, ...q};
    }).sort((a,b)=> a.expectedTotal - b.expectedTotal);
    return {newCarrierId: quotes[0].carrierId, expectedTotal: quotes[0].expectedTotal};
  }

  function retenderBest(shipmentId){
    const payload = {type:"RETENDER", shipmentId, ...bestRetenderQuote(shipmentId)};
    executeAction(payload);
  }

  function drawFuelChart(){
    const c = document.getElementById("fuelChart");
    if(!c || !window.Chart) return;
    // destroy old if exists
    if(state.ui.charts.fuel){ try{ state.ui.charts.fuel.destroy(); }catch(e){} }

    const labels = state.fuelIndex.map(x=> x.day<=0 ? `D${x.day}` : `Day ${x.day}`);
    const data = state.fuelIndex.map(x=> x.index);
    state.ui.charts.fuel = new Chart(c, {
      type: "line",
      data: { labels, datasets: [{label:"Fuel index", data, tension:0.25}]},
      options: {
        responsive:true,
        plugins:{ legend:{display:false} },
        scales:{
          x:{ ticks:{maxTicksLimit:8, color:"rgba(255,255,255,.55)"} , grid:{color:"rgba(255,255,255,.06)"} },
          y:{ ticks:{color:"rgba(255,255,255,.55)"}, grid:{color:"rgba(255,255,255,.06)"}, suggestedMin:0.85, suggestedMax:1.25 }
        }
      }
    });
  }

  // ---------- Page: Distribution ----------
  function renderDistribution(){
    const derived = deriveKpisAndExceptions();
    const rows = baseline.dcs.map(dc=>{
      const u = derived.util[dc.id];
      const effCap = u.capacity;
      const util = u.utilization;
      const risk = u.risk;
      return {
        dcId: dc.id,
        name: dc.name,
        effCap,
        inbound: u.inbound,
        outbound: u.outbound,
        util,
        risk
      };
    }).sort((a,b)=> b.risk - a.risk);

    const app = document.getElementById("app");
    app.innerHTML = `
      <div class="panel">
        <div class="split">
          <div>
            <h2>Distribution</h2>
            <div class="sub">DC throughput utilization (proxy) and “where the network will choke”. Effective capacity adjusts under scenarios (e.g., outage).</div>
          </div>
          <div class="controls">
            <span class="badge ${state.scenario.dcOutage?"warn":"ok"}">DC outage: ${state.scenario.dcOutage?"ON":"OFF"}</span>
            <span class="badge info">Effective capacity = baseline × scenario multiplier</span>
          </div>
        </div>

        <div class="twoCol" style="margin-top:12px;">
          <div class="panel" style="box-shadow:none; background:rgba(0,0,0,.12)">
            <h3>Utilization by DC</h3>
            <canvas id="utilChart" height="210"></canvas>
            <div class="smallNote">Risk ramps after ~85% utilization. This is explainable proxy logic for a demo.</div>
          </div>

          <div class="panel" style="box-shadow:none; background:rgba(0,0,0,.12)">
            <h3>Choke watchlist</h3>
            ${dcTable(rows)}
          </div>
        </div>
      </div>
    `;

    drawUtilChart(rows);
    app.querySelectorAll("[data-overflow]").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        const dcId = btn.getAttribute("data-overflow");
        executeAction({type:"REROUTE_OVERFLOW", dcId});
      });
    });
  }

  function dcTable(rows){
    const body = rows.map(r=>{
      const badge = r.risk>0.75?"bad":(r.risk>0.58?"warn":"ok");
      return `<tr>
        <td><div style="font-weight:900">${escapeHtml(r.name)}</div><div class="mono smallNote">${escapeHtml(r.dcId)}</div></td>
        <td class="mono">${fmtNum(r.util*100,0)}%</td>
        <td><span class="badge ${badge}">${fmtNum(r.risk*100,0)}%</span></td>
        <td><button class="btn btn-small btn-ghost" data-overflow="${escapeHtml(r.dcId)}">Activate overflow</button></td>
      </tr>`;
    }).join("");
    return `<table class="table">
      <thead><tr><th>DC</th><th>Util</th><th>Risk</th><th></th></tr></thead>
      <tbody>${body}</tbody>
    </table>`;
  }

  function drawUtilChart(rows){
    const c = document.getElementById("utilChart");
    if(!c || !window.Chart) return;
    if(state.ui.charts.util){ try{ state.ui.charts.util.destroy(); }catch(e){} }

    const labels = rows.map(r=> r.dcId);
    const data = rows.map(r=> round(r.util*100,1));
    state.ui.charts.util = new Chart(c, {
      type: "bar",
      data: { labels, datasets: [{label:"Utilization (%)", data}] },
      options: {
        plugins:{ legend:{display:false} },
        scales:{
          x:{ ticks:{color:"rgba(255,255,255,.55)"}, grid:{color:"rgba(255,255,255,.06)"} },
          y:{ ticks:{color:"rgba(255,255,255,.55)"}, grid:{color:"rgba(255,255,255,.06)"}, suggestedMax: 140 }
        }
      }
    });
  }

  // ---------- Page: Inventory ----------
  function renderInventory(){
    const derived = deriveKpisAndExceptions();
    const skuId = state.ui.selectedSkuId || baseline.skus[0].id;
    const sku = lookupSku(skuId);

    const docRows = baseline.dcs.map(dc=>{
      const d = getDemandPerDay(dc.id, skuId);
      const onHand = state.inventory[dc.id][skuId];
      const inTransit = inTransitTo(dc.id, skuId);
      const doc = onHand / Math.max(0.1,d);
      return {
        dcId: dc.id,
        name: dc.name,
        onHand,
        inTransit,
        demandPerDay: d,
        doc
      };
    }).sort((a,b)=> a.doc - b.doc);

    const proposals = rebalanceProposalsForSku(skuId).slice(0,10);

    const app = document.getElementById("app");
    app.innerHTML = `
      <div class="panel">
        <div class="split">
          <div>
            <h2>Inventory</h2>
            <div class="sub">Days-of-cover by DC for a selected SKU + SKU-specific rebalancing optimizer (greedy heuristic) ranked by net value = benefit − transfer cost (incl. transit days).</div>
          </div>
          <div class="controls">
            <select class="select" id="skuSelect">
              ${baseline.skus.map(s=>`<option value="${escapeHtml(s.id)}" ${s.id===skuId?"selected":""}>${escapeHtml(s.name)}</option>`).join("")}
            </select>
            <span class="badge info">Selected: ${escapeHtml(sku.id)}</span>
            <span class="badge ${state.scenario.demandSpike && state.scenarioPinned.spikeSkuId===skuId ? "warn":"ok"}">Demand multiplier: ${fmtNum((scenarioMultipliers().demandMult[skuId]||1)*100,0)}%</span>
          </div>
        </div>

        <div class="twoCol" style="margin-top:12px;">
          <div class="panel" style="box-shadow:none; background:rgba(0,0,0,.12)">
            <h3>Days of cover (on-hand + in-transit)</h3>
            <canvas id="docChart" height="220"></canvas>
            <div class="smallNote">DOC uses on-hand / demand-per-day; in-transit is displayed separately to show “pipeline”.</div>
          </div>

          <div class="panel" style="box-shadow:none; background:rgba(0,0,0,.12)">
            <h3>DOC by DC</h3>
            ${docTable(docRows)}
            <div class="smallNote">Targets (demo): <span class="mono">Low=7d</span>, <span class="mono">High=21d</span>. Rebalancing tries to push low up and high down.</div>
          </div>
        </div>

        <hr class="sep" />

        <div class="panel" style="box-shadow:none; background:rgba(0,0,0,.12)">
          <div class="split">
            <div>
              <h3>Rebalancing recommendations (transparent greedy heuristic)</h3>
              <div class="sub">Ranked by net value = benefit − transfer cost, including transit days.</div>
            </div>
            <div class="controls">
              <button class="btn btn-small" id="btnRunTop">Execute top transfer</button>
            </div>
          </div>
          ${rebalanceTable(proposals)}
        </div>
      </div>
    `;

    // wire SKU selection
    app.querySelector("#skuSelect").addEventListener("change", (e)=>{
      state.ui.selectedSkuId = e.target.value;
      render();
    });

    // wire execute buttons
    app.querySelectorAll("[data-xfer]").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        const payload = JSON.parse(btn.getAttribute("data-xfer"));
        executeAction({type:"REBALANCE_TRANSFER", ...payload});
      });
    });
    app.querySelector("#btnRunTop").addEventListener("click", ()=> runTopRebalanceAndExecute());

    drawDocChart(docRows);
  }

  function getDemandPerDay(dcId, skuId){
    const derived = deriveKpisAndExceptions();
    const m = derived.multipliers;
    const base = baseline.demand[dcId][skuId] || 0;
    const mult = (m.demandMult[skuId] || 1.0) * (state.scenario.cyberDegraded ? 1.05 : 1.0);
    return round(base*mult, 1);
  }

  function inTransitTo(dcId, skuId){
    let s=0;
    for(const sh of state.shipments){
      if(sh.status==="delivered") continue;
      if(sh.to===dcId && sh.sku===skuId) s += sh.qty;
    }
    return s;
  }

  function docTable(rows){
    const body = rows.map(r=>{
      const badge = r.doc<7 ? "bad" : (r.doc<10 ? "warn":"ok");
      return `<tr>
        <td><div style="font-weight:900">${escapeHtml(r.name)}</div><div class="mono smallNote">${escapeHtml(r.dcId)}</div></td>
        <td class="mono">${fmtNum(r.onHand)}</td>
        <td class="mono">${fmtNum(r.inTransit)}</td>
        <td class="mono">${fmtNum(r.demandPerDay,1)}</td>
        <td><span class="badge ${badge}">${fmtNum(r.doc,1)}d</span></td>
      </tr>`;
    }).join("");
    return `<table class="table">
      <thead><tr><th>DC</th><th>On-hand</th><th>In-transit</th><th>Demand/day</th><th>DOC</th></tr></thead>
      <tbody>${body}</tbody>
    </table>`;
  }

  function rebalanceTable(proposals){
    if(!proposals.length) return `<div class="callout">No positive-net-value transfers found for this SKU under current conditions.</div>`;
    const body = proposals.map(p=>{
      return `<tr>
        <td>${escapeHtml(p.fromDcId)} → ${escapeHtml(p.toDcId)}</td>
        <td class="mono">${fmtNum(p.qty)}</td>
        <td class="mono">${p.transitDays}d</td>
        <td class="mono">${fmtUSD(p.benefit)}</td>
        <td class="mono">${fmtUSD(p.transferCost)}</td>
        <td class="mono"><b>${fmtUSD(p.netValue)}</b></td>
        <td><button class="btn btn-small" data-xfer='${JSON.stringify(p)}'>Execute</button></td>
      </tr>`;
    }).join("");
    return `<table class="table">
      <thead><tr><th>Transfer</th><th>Qty</th><th>Transit</th><th>Benefit</th><th>Cost</th><th>Net value</th><th></th></tr></thead>
      <tbody>${body}</tbody>
    </table>`;
  }

  function drawDocChart(rows){
    const c = document.getElementById("docChart");
    if(!c || !window.Chart) return;
    if(state.ui.charts.doc){ try{ state.ui.charts.doc.destroy(); }catch(e){} }

    const labels = rows.map(r=> r.dcId);
    const data = rows.map(r=> round(r.doc,1));
    state.ui.charts.doc = new Chart(c, {
      type: "bar",
      data: {labels, datasets:[{label:"DOC (days)", data}]},
      options: {
        plugins:{ legend:{display:false} },
        scales:{
          x:{ ticks:{color:"rgba(255,255,255,.55)"}, grid:{color:"rgba(255,255,255,.06)"} },
          y:{ ticks:{color:"rgba(255,255,255,.55)"}, grid:{color:"rgba(255,255,255,.06)"}, suggestedMax: 35 }
        }
      }
    });
  }

  function rebalanceProposalsForSku(skuId){
    const dcs = baseline.dcs;
    const sku = lookupSku(skuId);

    // Targets
    const low = 7.0;
    const high = 21.0;

    // Build supply (excess) and demand (need)
    const supply = [];
    const need = [];
    for(const dc of dcs){
      const d = getDemandPerDay(dc.id, skuId);
      const onHand = state.inventory[dc.id][skuId];
      const doc = onHand / Math.max(0.1,d);
      const excessUnits = Math.max(0, Math.round((doc - high) * d));
      const needUnits = Math.max(0, Math.round((low - doc) * d));
      if(excessUnits > 0) supply.push({dcId: dc.id, excessUnits, doc, d});
      if(needUnits > 0) need.push({dcId: dc.id, needUnits, doc, d});
    }

    // greedy: match largest need to largest supply
    supply.sort((a,b)=> b.excessUnits - a.excessUnits);
    need.sort((a,b)=> b.needUnits - a.needUnits);

    // approximate transfer cost and benefit:
    // benefit = avoided shortage penalty ~ units * unitMargin * factor
    // transferCost = units * (base handling + per-mile per-unit) + units * holding per day
    const proposals = [];
    const baseHandlingPerUnit = 0.06;
    const perMilePerUnit = 0.00085;
    const holdingPerUnitPerDay = 0.008;

    // precompute distances between DCs using node coords
    const nodeById = Object.fromEntries(baseline.nodes.map(n=>[n.id,n]));
    const R=3958.8;
    const toRad=(x)=>x*Math.PI/180;
    function miles(aId,bId){
      const a=nodeById[aId], b=nodeById[bId];
      const dLat=toRad(b.lat-a.lat), dLon=toRad(b.lon-a.lon);
      const lat1=toRad(a.lat), lat2=toRad(b.lat);
      const h = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
      return 2*R*Math.asin(Math.sqrt(h));
    }
    function transitDays(m){ return clamp(Math.round(m/520 + 1.1), 1, 6); }

    // Greedy matching
    const supplyCopy = supply.map(x=>({...x}));
    const needCopy = need.map(x=>({...x}));

    for(const n of needCopy){
      let remainingNeed = n.needUnits;
      for(const s of supplyCopy){
        if(remainingNeed<=0) break;
        if(s.excessUnits<=0) continue;
        const qty = Math.min(remainingNeed, s.excessUnits, 2200); // cap to keep it realistic
        const mls = miles(s.dcId, n.dcId);
        const td = transitDays(mls);

        const benefit = Math.round(qty * sku.unitMargin * 2.8); // shortage/service avoidance proxy
        const transferCost = Math.round(qty * (baseHandlingPerUnit + mls*perMilePerUnit) + qty*holdingPerUnitPerDay*td);

        const netValue = benefit - transferCost;
        if(netValue > 0){
          proposals.push({
            skuId,
            fromDcId: s.dcId,
            toDcId: n.dcId,
            qty,
            miles: Math.round(mls),
            transitDays: td,
            benefit,
            transferCost,
            netValue
          });
        }
        s.excessUnits -= qty;
        remainingNeed -= qty;
      }
    }

    proposals.sort((a,b)=> b.netValue - a.netValue);
    return proposals;
  }

  function getTopRebalanceForSku(skuId){
    const p = rebalanceProposalsForSku(skuId);
    return p.length ? p[0] : null;
  }

  function runTopRebalanceAndExecute(){
    const skuId = state.ui.selectedSkuId || baseline.skus[0].id;
    const best = getTopRebalanceForSku(skuId);
    if(!best){
      toast("No transfer executed", "No positive-net-value transfers found for the selected SKU.");
      return;
    }
    executeAction({type:"REBALANCE_TRANSFER", ...best});
  }

  // ---------- Page: Scenario Simulator ----------
  function renderScenario(){
    const derived = deriveKpisAndExceptions();

    const app = document.getElementById("app");
    app.innerHTML = `
      <div class="panel">
        <div class="split">
          <div>
            <h2>Scenario Simulator</h2>
            <div class="sub">Toggle disruption scenarios and run “live” to watch exceptions and KPIs shift. This is stateful and updates in-browser.</div>
          </div>
          <div class="controls">
            <button class="btn btn-small ${state.simRunning?"btn-danger":""}" id="btnSim">${state.simRunning?"Stop live run":"Run live"}</button>
            <button class="btn btn-small btn-ghost" id="btnStep">Step +1 day</button>
          </div>
        </div>

        <div class="twoCol" style="margin-top:12px;">
          <div class="panel" style="box-shadow:none; background:rgba(0,0,0,.12)">
            <h3>Scenario toggles</h3>
            <div class="smallNote">Pinned impacts remain consistent while toggles are ON (e.g., same outage DC, same disrupted carrier, same spike SKU).</div>
            <div style="margin-top:10px;" class="kv">
              ${toggle("dcOutage","DC outage", "Cuts effective capacity at one DC; shipments touching it get higher late risk.")}
              ${toggle("carrierDisruption","Carrier disruption", "Reduces on-time of one carrier; retender becomes valuable.")}
              ${toggle("demandSpike","Demand spike", "Increases demand burn-rate for one SKU across DCs.")}
              ${toggle("cyberDegraded","Cyber degraded mode", "Execution restricted; use Playbooks to produce manual plan and audit trail.")}
            </div>
          </div>

          <div class="panel" style="box-shadow:none; background:rgba(0,0,0,.12)">
            <h3>KPIs (live)</h3>
            <div class="kv">
              <div class="item"><div class="k">Value-at-risk</div><div class="v">${fmtUSD(derived.kpis.valueAtRisk)}</div></div>
              <div class="item"><div class="k">Service risk</div><div class="v">${fmtNum(derived.kpis.serviceRisk*100,0)}%</div></div>
              <div class="item"><div class="k">Avg DC utilization</div><div class="v">${fmtNum(derived.kpis.avgDcUtil*100,0)}%</div></div>
              <div class="item"><div class="k">At-risk shipments</div><div class="v">${derived.kpis.lateShipments}</div></div>
            </div>
            <hr class="sep" />
            <h3>What changed</h3>
            <div class="smallNote">Exceptions below are recomputed on every tick using the same transparent model used elsewhere.</div>
            ${exceptionsTable(derived.exceptions.slice(0,8))}
          </div>
        </div>

        <hr class="sep" />

        <div class="panel" style="box-shadow:none; background:rgba(0,0,0,.12)">
          <h3>Suggested next moves</h3>
          <div class="controls">
            <button class="btn btn-small" data-route="#/control">Open Control Tower</button>
            <button class="btn btn-small" data-route="#/inventory">Open Inventory</button>
            <button class="btn btn-small" data-route="#/transport">Open Transportation</button>
            <button class="btn btn-small" data-route="#/playbooks">Open Playbooks</button>
          </div>
          <div class="smallNote" style="margin-top:8px;">Tip: Turn on Cyber degraded mode to show how guardrails prevent auto-execution while still generating a plan.</div>
        </div>
      </div>
    `;

    // wire toggles
    app.querySelectorAll("[data-toggle]").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        const k = btn.getAttribute("data-toggle");
        state.scenario[k] = !state.scenario[k];
        toast("Scenario updated", `${btn.getAttribute("data-label")}: ${state.scenario[k]?"ON":"OFF"}`);
        render();
      });
    });

    // wire live run / step
    app.querySelector("#btnSim").addEventListener("click", ()=> state.simRunning ? stopSim() : startSim());
    app.querySelector("#btnStep").addEventListener("click", ()=> tick());
    app.querySelectorAll("[data-route]").forEach(b=> b.addEventListener("click", ()=> location.hash=b.getAttribute("data-route")));
  }

  function toggle(key, label, desc){
    const on = state.scenario[key];
    return `
      <div class="item">
        <div class="k">${escapeHtml(label)}</div>
        <div class="v">
          <button class="btn btn-small ${on?"":"btn-ghost"}" data-toggle="${escapeHtml(key)}" data-label="${escapeHtml(label)}">
            ${on?"ON":"OFF"}
          </button>
        </div>
        <div class="smallNote">${escapeHtml(desc)}</div>
      </div>
    `;
  }

  // ---------- Page: Playbooks ----------
  function renderPlaybooks(){
    const derived = deriveKpisAndExceptions();
    const top = derived.exceptions.slice(0,6);

    const app = document.getElementById("app");
    app.innerHTML = `
      <div class="panel">
        <div class="split">
          <div>
            <h2>Playbooks</h2>
            <div class="sub">Standard “exception → decision → execution” workflows with guardrails. Use this to show agentic patterns without claiming full autonomy.</div>
          </div>
          <div class="controls">
            <span class="badge ${state.scenario.cyberDegraded?"warn":"ok"}">Cyber degraded mode: ${state.scenario.cyberDegraded?"ON":"OFF"}</span>
            <button class="btn btn-small btn-ghost" data-route="#/scenario">Open Scenario Simulator</button>
          </div>
        </div>

        <div class="twoCol" style="margin-top:12px;">
          <div class="panel" style="box-shadow:none; background:rgba(0,0,0,.12)">
            <h3>Workflow templates</h3>
            ${playbookCard("Inventory stockout prevention",
              ["Detect low DOC + inbound uncertainty", "Diagnose root cause (demand spike? DC choke? supplier delay?)", "Propose actions (rebalance, expedite, allocation changes)", "Guardrails (cost thresholds, cyber mode, approval policy)", "Approve & execute", "Audit trail (snapshot + action log)"],
              state.scenario.cyberDegraded ? "Execution is blocked: generate a manual plan + export snapshot for approval." : "Execution is enabled: approve actions in Control Tower / Inventory."
            )}
            ${playbookCard("Shipment late-risk mitigation",
              ["Detect high late probability + penalty exposure", "Compute expected total cost by carrier", "Recommend retender (or split shipment)", "Guardrails (carrier capacity, cyber mode)", "Approve & execute retender", "Audit trail"],
              "Transportation module uses the same late-probability model for display and ranking."
            )}
            ${playbookCard("DC choke response",
              ["Detect utilization > 85% and rising", "Identify flow drivers (inbound wave, outbound peak)", "Propose overflow/reroute + inventory shifts", "Guardrails (service impact, cost caps)", "Approve & execute", "Audit trail"],
              "Distribution shows choke points; Control Tower ties to actions."
            )}
          </div>

          <div class="panel" style="box-shadow:none; background:rgba(0,0,0,.12)">
            <h3>Apply playbook to a live exception</h3>
            <div class="smallNote">Pick one of the current exceptions; this generates a recommended plan. If cyber mode is ON, execution is restricted but the plan and audit trail still work.</div>
            <div class="controls" style="margin-top:10px;">
              <select class="select" id="excSelect">
                ${top.map(e=>`<option value="${escapeHtml(e.id)}">${escapeHtml(e.type)} • ${escapeHtml(e.id)}</option>`).join("")}
              </select>
              <button class="btn btn-small" id="btnGen">Generate plan</button>
            </div>
            <div id="planBox" style="margin-top:12px;">${planEmpty()}</div>
          </div>
        </div>
      </div>
    `;

    app.querySelectorAll("[data-route]").forEach(b=> b.addEventListener("click", ()=> location.hash=b.getAttribute("data-route")));
    app.querySelector("#btnGen").addEventListener("click", ()=>{
      const id = app.querySelector("#excSelect").value;
      const e = deriveKpisAndExceptions().exceptions.find(x=>x.id===id);
      const planBox = document.getElementById("planBox");
      planBox.innerHTML = renderPlanForException(e);
      // wire plan buttons
      planBox.querySelectorAll("[data-route]").forEach(b=> b.addEventListener("click", ()=> location.hash=b.getAttribute("data-route")));
      planBox.querySelectorAll("[data-exec]").forEach(b=> b.addEventListener("click", ()=>{
        const payload = JSON.parse(b.getAttribute("data-exec"));
        executeAction(payload);
      }));
      planBox.querySelectorAll("[data-snapshot]").forEach(b=> b.addEventListener("click", ()=> downloadSnapshot()));
    });
  }

  function playbookCard(title, steps, note){
    return `
      <div class="panel" style="box-shadow:none; background:rgba(0,0,0,.18); margin-top:12px;">
        <div class="split">
          <div>
            <div style="font-weight:900">${escapeHtml(title)}</div>
            <div class="smallNote">${escapeHtml(note)}</div>
          </div>
          <div><span class="badge info">Playbook</span></div>
        </div>
        <ul class="smallNote" style="margin:10px 0 0 18px; line-height:1.55">
          ${steps.map(s=>`<li>${escapeHtml(s)}</li>`).join("")}
        </ul>
      </div>
    `;
  }

  function planEmpty(){
    return `<div class="callout">Generate a plan to see: why → recommended actions → guardrails → audit export.</div>`;
  }

  function renderPlanForException(e){
    if(!e) return planEmpty();
    const derived = deriveKpisAndExceptions();
    const actions = recommendedActionsForException(e, derived);
    const blocked = state.scenario.cyberDegraded;

    const actionList = actions.map(a=>{
      return `
        <div class="panel" style="box-shadow:none; background:rgba(0,0,0,.18); margin-top:10px;">
          <div style="font-weight:900">${escapeHtml(a.label)}</div>
          <div class="smallNote">${escapeHtml(a.why)}</div>
          <div class="smallNote mono">Impact: ${escapeHtml(a.impact)}</div>
          <div class="controls" style="margin-top:10px;">
            <button class="btn btn-small ${blocked?"btn-danger":""}" data-exec='${JSON.stringify(a.payload)}'>${blocked?"Blocked":"Approve & execute"}</button>
            ${a.route ? `<button class="btn btn-small btn-ghost" data-route="${a.route}">Open module</button>`:""}
          </div>
        </div>
      `;
    }).join("");

    return `
      <div class="panel" style="box-shadow:none; background:rgba(0,0,0,.12)">
        <div class="big">${escapeHtml(e.type)}</div>
        <div class="smallNote mono">${escapeHtml(e.id)}</div>
        <div class="callout" style="margin-top:10px;"><b>Why:</b> ${escapeHtml(e.why||"—")}</div>
        <hr class="sep" />
        <div class="split">
          <div>
            <div style="font-weight:900">Recommended actions</div>
            <div class="smallNote">Guardrails enforce cyber mode and block execution when enabled.</div>
          </div>
          <div class="controls">
            <button class="btn btn-small btn-ghost" data-snapshot="1">Download audit snapshot</button>
          </div>
        </div>
        ${actionList || `<div class="callout">No actions available.</div>`}
      </div>
    `;
  }

  // ---------- Page: Data Explorer ----------
  function renderData(){
    const derived = deriveKpisAndExceptions();

    const dataset = {
      baseline: baseline,
      current: {
        day: state.day,
        scenario: state.scenario,
        scenarioPinned: state.scenarioPinned,
        inventory: state.inventory,
        shipments: state.shipments,
        fuelIndex: state.fuelIndex,
        derived: {
          kpis: derived.kpis,
          exceptions: derived.exceptions.slice(0,30),
        }
      }
    };

    const app = document.getElementById("app");
    app.innerHTML = `
      <div class="panel">
        <div class="split">
          <div>
            <h2>Data Explorer</h2>
            <div class="sub">View and download the synthetic dataset JSON. Also export a “snapshot” of current state + action log (audit trail).</div>
          </div>
          <div class="controls">
            <button class="btn btn-small" id="btnDownloadDataset">Download dataset JSON</button>
            <button class="btn btn-small btn-ghost" id="btnDownloadSnapshot">Download snapshot JSON</button>
          </div>
        </div>
        <textarea class="code" id="jsonBox" spellcheck="false"></textarea>
        <div class="smallNote">Tip: This makes the demo feel “real” and supports client questions about “what data would you connect to in production?”</div>
      </div>
    `;

    const box = app.querySelector("#jsonBox");
    box.value = JSON.stringify(dataset, null, 2);

    app.querySelector("#btnDownloadDataset").addEventListener("click", ()=>{
      downloadJson("synthetic_dataset.json", baseline);
      toast("Downloaded", "synthetic_dataset.json");
    });

    app.querySelector("#btnDownloadSnapshot").addEventListener("click", ()=> downloadSnapshot());
  }

  // ---------- Shared small components ----------
  function exceptionsTable(exceptions){
    const rows = (exceptions||[]).map(e=>{
      const badge = e.riskScore>0.78 ? "bad" : (e.riskScore>0.62 ? "warn":"ok");
      const ref = e.type==="Shipment Late Risk" ? e.shipmentId : (e.dcId ? `${e.dcId}${e.skuId?(" • "+e.skuId):""}` : "");
      const signal = e.doc!=null ? `${fmtNum(e.doc,1)}d DOC` : (e.utilization!=null ? `${fmtNum(e.utilization*100,0)}% util` : (e.lateProb!=null ? `${fmtNum(e.lateProb*100,1)}% late` : "—"));
      return `<tr>
        <td><span class="badge ${badge}">${fmtNum(e.riskScore*100,0)}%</span></td>
        <td>${escapeHtml(e.type)}<div class="smallNote mono">${escapeHtml(ref)}</div></td>
        <td class="mono">${fmtUSD(e.valueAtRisk)}</td>
        <td class="mono">${escapeHtml(signal)}</td>
      </tr>`;
    }).join("");
    return `<table class="table"><thead><tr><th>Risk</th><th>Exception</th><th>VaR</th><th>Signal</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  function actionLogTable(rows){
    if(!rows || !rows.length) return `<div class="callout">No actions yet. Approve & execute from any module to populate the audit trail.</div>`;
    const body = rows.map(r=>{
      return `<tr>
        <td class="mono">${escapeHtml(r.ts.slice(11,19))}</td>
        <td class="mono">D${r.day}</td>
        <td><div style="font-weight:900">${escapeHtml(r.type)}</div><div class="smallNote">${escapeHtml(r.detail||"")}</div></td>
      </tr>`;
    }).join("");
    return `<table class="table"><thead><tr><th>Time</th><th>Day</th><th>Event</th></tr></thead><tbody>${body}</tbody></table>`;
  }

  function lookupDc(dcId){ return baseline.dcs.find(d=>d.id===dcId) || {id:dcId, name:dcId}; }
  function lookupSku(skuId){ return baseline.skus.find(s=>s.id===skuId) || {id:skuId, name:skuId, unitMargin:1.0}; }

  function downloadSnapshot(){
    const derived = deriveKpisAndExceptions();
    const snapshot = {
      capturedAt: new Date().toISOString(),
      day: state.day,
      scenario: state.scenario,
      scenarioPinned: state.scenarioPinned,
      overflowBoost: state.overflowBoost,
      kpis: derived.kpis,
      topExceptions: derived.exceptions.slice(0,30),
      inventory: state.inventory,
      shipments: state.shipments,
      fuelIndex: state.fuelIndex,
      actionLog: state.actionLog
    };
    downloadJson(`snapshot_day_${state.day}.json`, snapshot);
    toast("Downloaded snapshot", `snapshot_day_${state.day}.json`);
    logAction({type:"SNAPSHOT_DOWNLOADED", detail:`Downloaded snapshot_day_${state.day}.json`, meta:{day:state.day}});
    render();
  }

  // ---------- Global buttons ----------
  function wireTopbar(){
    document.getElementById("btnSnapshot").addEventListener("click", ()=> downloadSnapshot());
    document.getElementById("btnReset").addEventListener("click", ()=>{
      stopSim();
      baseline = generateBaseline(BASE_SEED);
      state.day = 0;
      state.scenario = {dcOutage:false, carrierDisruption:false, demandSpike:false, cyberDegraded:false};
      state.scenarioPinned = {outageDcId:null, disruptedCarrierId:null, spikeSkuId:null};
      state.inventory = deepCopy(baseline.inventory);
      state.shipments = deepCopy(baseline.shipments);
      state.fuelIndex = deepCopy(baseline.fuelIndex);
      state.actionLog = [];
      state.overflowBoost = {};
      state.ui.selectedSkuId = baseline.skus[0].id;
      state.ui.selectedExceptionId = null;
      toast("Reset", "State reset to baseline synthetic dataset.");
      render();
    });
  }

  // ---------- Startup ----------
  window.addEventListener("hashchange", render);
  window.addEventListener("load", ()=>{
    wireTopbar();
    // default route
    if(!location.hash) location.hash="#/exec";
    render();
  });

})();