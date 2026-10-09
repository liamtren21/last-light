/** Original procedural shore ambience; no media from the source game. */
export class ShoreAmbience {
  private context?: AudioContext;
  private source?: AudioBufferSourceNode;
  private wind?: OscillatorNode;
  private filter?: BiquadFilterNode;
  private gain?: GainNode;
  private scene:'ferry'|'tower'|'signal'='ferry';
  setScene(scene:'ferry'|'tower'|'signal') {
    this.scene=scene;
    if(!this.context)return;
    this.filter?.frequency.setTargetAtTime(scene==='signal'?350:scene==='tower'?950:620,this.context.currentTime,.35);
    this.gain?.gain.setTargetAtTime(scene==='signal'?.085:scene==='tower'?.24:.2,this.context.currentTime,.35);
  }
  async setEnabled(enabled: boolean) {
    if (!enabled) { await this.context?.suspend(); return; }
    if (!this.context) {
      const context = new AudioContext(); this.context = context;
      const buffer = context.createBuffer(1, context.sampleRate * 12, context.sampleRate);
      const channel = buffer.getChannelData(0);
      let brown = 0;
      for (let i = 0; i < channel.length; i++) {
        brown = (brown + (Math.random() * 2 - 1) * .02) / 1.02;
        channel[i] = brown * 3;
      }
      const source = context.createBufferSource(); source.buffer = buffer; source.loop = true;
      const filter = context.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 620;
      const gain = context.createGain(); gain.gain.value = .2;
      this.filter=filter;this.gain=gain;this.setScene(this.scene);
      const wave = context.createOscillator(); wave.frequency.value = .12;
      const swell = context.createGain(); swell.gain.value = .055;
      wave.connect(swell).connect(gain.gain);
      source.connect(filter).connect(gain).connect(context.destination);
      source.start(); wave.start(); this.source = source; this.wind = wave;
    }
    await this.context.resume();
  }
  cue(kind:'paper'|'radio'){
    const context=this.context;if(!context||context.state!=='running')return;
    const duration=kind==='paper'?.18:.07;
    const buffer=context.createBuffer(1,Math.ceil(context.sampleRate*duration),context.sampleRate);
    const samples=buffer.getChannelData(0);for(let i=0;i<samples.length;i++)samples[i]=(Math.random()*2-1)*(1-i/samples.length);
    const source=context.createBufferSource();source.buffer=buffer;const filter=context.createBiquadFilter();filter.type='bandpass';filter.frequency.value=kind==='paper'?1800:900;
    const gain=context.createGain();gain.gain.value=.04;source.connect(filter).connect(gain).connect(context.destination);source.onended=()=>{source.disconnect();filter.disconnect();gain.disconnect();};source.start();
  }
  dispose() { this.source?.stop(); this.wind?.stop(); void this.context?.close(); }
}
