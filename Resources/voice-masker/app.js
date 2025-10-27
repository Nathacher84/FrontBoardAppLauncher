const AudioCtx = window.AudioContext || window.webkitAudioContext;

class NeuralVoiceAdvisor {
  constructor() {
    // Simple neural-style weights approximated from offline training.
    this.weights = [
      { label: 'grave', weights: [1.4, -0.8], bias: -0.2, pitch: 0.55, distortion: 0.48 },
      { label: 'oscuro', weights: [1.1, -0.2], bias: -0.05, pitch: 0.65, distortion: 0.35 },
      { label: 'metálico', weights: [0.8, 0.6], bias: 0.12, pitch: 0.75, distortion: 0.62 }
    ];
  }

  activate(features) {
    const [rms, zcr] = features;
    let bestScore = -Infinity;
    let best = this.weights[0];
    for (const node of this.weights) {
      const score = node.weights[0] * rms + node.weights[1] * zcr + node.bias;
      if (score > bestScore) {
        bestScore = score;
        best = node;
      }
    }
    const squeeze = (value, low, high) => Math.min(Math.max(value, low), high);
    return {
      pitch: squeeze(best.pitch + bestScore * 0.05, 0.35, 0.85),
      distortion: squeeze(best.distortion + bestScore * 0.04, 0.2, 0.9)
    };
  }
}

class VoiceMasker {
  constructor() {
    this.audioContext = null;
    this.mediaStream = null;
    this.pitchNode = null;
    this.pitchParam = null;
    this.distortionNode = null;
    this.lowpassNode = null;
    this.analyserIn = null;
    this.analyserOut = null;
    this.gainNode = null;
    this.sourceNode = null;
    this.animationFrame = null;
    this.started = false;
    this.voiceAdvisor = new NeuralVoiceAdvisor();
    this.features = { rms: 0, zcr: 0 };
    this.pitchAmount = 0.7;
    this.distortionAmount = 0.35;
    this.lowpassFrequency = 1200;
  }

  async init() {
    if (!AudioCtx) {
      throw new Error('AudioContext no disponible en este navegador.');
    }
    if (!window.isSecureContext) {
      console.warn('Se recomienda ejecutar la app desde https para acceder al micrófono.');
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('getUserMedia no soportado.');
    }
    if (!this.audioContext) {
      this.audioContext = new AudioCtx({ latencyHint: 'interactive' });
      if (!this.audioContext.audioWorklet) {
        throw new Error('AudioWorklet no soportado por el navegador.');
      }
      await this.audioContext.audioWorklet.addModule('pitch-worklet.js');
      this.buildGraph();
    }
  }

  buildGraph() {
    this.pitchNode = new AudioWorkletNode(this.audioContext, 'pitch-mask-processor', {
      parameterData: { pitch: this.pitchAmount }
    });
    this.pitchParam = this.pitchNode.parameters.get('pitch');

    this.distortionNode = this.audioContext.createWaveShaper();
    this.updateDistortionCurve(this.distortionAmount);

    this.lowpassNode = this.audioContext.createBiquadFilter();
    this.lowpassNode.type = 'lowpass';
    this.lowpassNode.frequency.setValueAtTime(this.lowpassFrequency, this.audioContext.currentTime);
    this.lowpassNode.Q.setValueAtTime(1.1, this.audioContext.currentTime);

    this.gainNode = this.audioContext.createGain();
    this.gainNode.gain.value = 0.9;

    this.analyserIn = this.audioContext.createAnalyser();
    this.analyserIn.fftSize = 512;
    this.analyserOut = this.audioContext.createAnalyser();
    this.analyserOut.fftSize = 512;
  }

  async toggleMic(active) {
    if (active && !this.started) {
      await this.init();
      this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
      this.sourceNode.connect(this.analyserIn);
      this.analyserIn.connect(this.pitchNode);
      this.pitchNode.connect(this.distortionNode);
      this.distortionNode.connect(this.lowpassNode);
      this.lowpassNode.connect(this.gainNode);
      this.gainNode.connect(this.analyserOut);
      this.analyserOut.connect(this.audioContext.destination);
      await this.audioContext.resume();
      this.started = true;
      this.startMeters();
    } else if (!active && this.started) {
      this.stop();
    }
  }

  stop() {
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }
    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch (error) {
        console.warn('No se pudo desconectar la fuente', error);
      }
      this.sourceNode = null;
    }
    if (this.pitchNode) {
      this.pitchNode.disconnect();
    }
    if (this.analyserIn) {
      try {
        this.analyserIn.disconnect();
      } catch (error) {
        console.warn('No se pudo desconectar el analizador de entrada', error);
      }
    }
    if (this.analyserOut) {
      try {
        this.analyserOut.disconnect();
      } catch (error) {
        console.warn('No se pudo desconectar el analizador de salida', error);
      }
    }
    if (this.distortionNode) {
      this.distortionNode.disconnect();
    }
    if (this.lowpassNode) {
      this.lowpassNode.disconnect();
    }
    if (this.gainNode) {
      this.gainNode.disconnect();
    }
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
    if (this.pitchNode) {
      this.pitchNode.port.postMessage({ type: 'reset' });
    }
    this.started = false;
  }

  startMeters() {
    const inputData = new Float32Array(this.analyserIn.fftSize);
    const outputData = new Float32Array(this.analyserOut.fftSize);
    const update = () => {
      this.analyserIn.getFloatTimeDomainData(inputData);
      this.analyserOut.getFloatTimeDomainData(outputData);
      const inRms = this.computeRms(inputData);
      const outRms = this.computeRms(outputData);
      this.features.rms = inRms;
      this.features.zcr = this.zeroCrossRate(inputData);
      this.updateMeters(inRms, outRms);
      this.pushAiSuggestion();
      this.animationFrame = requestAnimationFrame(update);
    };
    update();
  }

  computeRms(buffer) {
    let sum = 0;
    for (let i = 0; i < buffer.length; i++) {
      sum += buffer[i] * buffer[i];
    }
    return Math.sqrt(sum / buffer.length);
  }

  zeroCrossRate(buffer) {
    let crossings = 0;
    for (let i = 1; i < buffer.length; i++) {
      if ((buffer[i - 1] >= 0 && buffer[i] < 0) || (buffer[i - 1] < 0 && buffer[i] >= 0)) {
        crossings++;
      }
    }
    return crossings / buffer.length;
  }

  updateMeters(inputLevel, outputLevel) {
    const inMeter = document.getElementById('input-meter');
    const outMeter = document.getElementById('output-meter');
    if (inMeter) {
      inMeter.value = Math.min(inputLevel * 6, 1);
    }
    if (outMeter) {
      outMeter.value = Math.min(outputLevel * 6, 1);
    }
  }

  pushAiSuggestion() {
    if (!this.started || !this.voiceAdvisor) return;
    const suggestion = this.voiceAdvisor.activate([this.features.rms, this.features.zcr]);
    const aiPitch = document.getElementById('ai-pitch');
    const aiDistortion = document.getElementById('ai-distortion');
    if (aiPitch && aiDistortion) {
      aiPitch.textContent = suggestion.pitch.toFixed(2) + 'x';
      aiDistortion.textContent = Math.round(suggestion.distortion * 100) + '%';
    }
  }

  setPitch(value) {
    this.pitchAmount = value;
    if (!this.pitchParam || !this.audioContext) return;
    this.pitchParam.setValueAtTime(value, this.audioContext.currentTime);
  }

  updateDistortionCurve(amount) {
    if (!this.audioContext) {
      return;
    }
    const k = amount * 100;
    const curve = new Float32Array(44100);
    const deg = Math.PI / 180;
    for (let i = 0; i < curve.length; ++i) {
      const x = (i * 2) / curve.length - 1;
      curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
    }
    if (!this.distortionNode) {
      this.distortionNode = this.audioContext.createWaveShaper();
    }
    this.distortionNode.curve = curve;
    this.distortionNode.oversample = '4x';
  }

  setDistortion(amount) {
    this.distortionAmount = amount;
    if (!this.audioContext) return;
    this.updateDistortionCurve(amount);
  }

  setLowpass(freq) {
    this.lowpassFrequency = freq;
    if (!this.lowpassNode || !this.audioContext) return;
    this.lowpassNode.frequency.setTargetAtTime(freq, this.audioContext.currentTime, 0.05);
  }

  applyProfile(name) {
    const profiles = {
      warden: { pitch: 0.62, distortion: 0.45, lowpass: 1400 },
      leviathan: { pitch: 0.45, distortion: 0.65, lowpass: 950 },
      shadow: { pitch: 0.58, distortion: 0.38, lowpass: 1100 }
    };
    const profile = profiles[name];
    if (!profile) return profile;
    this.setPitch(profile.pitch);
    this.setDistortion(profile.distortion);
    this.setLowpass(profile.lowpass);
    return profile;
  }
}

const voiceMasker = new VoiceMasker();

const pitchSlider = document.getElementById('pitch-slider');
const pitchValue = document.getElementById('pitch-value');
const distortionSlider = document.getElementById('distortion-slider');
const distortionValue = document.getElementById('distortion-value');
const lowpassSlider = document.getElementById('lowpass-slider');
const lowpassValue = document.getElementById('lowpass-value');
const toggleMicBtn = document.getElementById('toggle-mic');
const micStatus = document.getElementById('mic-status');
const profileButtons = Array.from(document.querySelectorAll('.profile'));
const speakBtn = document.getElementById('speak-btn');
const voiceSelect = document.getElementById('voice-select');

function updatePitchDisplay(value) {
  pitchValue.textContent = `${value.toFixed(2)}x`;
}

function updateDistortionDisplay(value) {
  distortionValue.textContent = `${Math.round(value * 100)}%`;
}

function updateLowpassDisplay(value) {
  lowpassValue.textContent = `${Math.round(value)} Hz`;
}

pitchSlider.addEventListener('input', (event) => {
  const value = parseFloat(event.target.value);
  updatePitchDisplay(value);
  voiceMasker.setPitch(value);
});

distortionSlider.addEventListener('input', (event) => {
  const value = parseFloat(event.target.value);
  updateDistortionDisplay(value);
  voiceMasker.setDistortion(value);
});

lowpassSlider.addEventListener('input', (event) => {
  const value = parseFloat(event.target.value);
  updateLowpassDisplay(value);
  voiceMasker.setLowpass(value);
});

let micActive = false;

toggleMicBtn.addEventListener('click', async () => {
  try {
    micActive = !micActive;
    await voiceMasker.toggleMic(micActive);
    if (micActive) {
      toggleMicBtn.textContent = 'Detener micrófono';
      micStatus.textContent = 'Micrófono activo';
      micStatus.classList.remove('status-off');
      micStatus.classList.add('status-on');
    } else {
      toggleMicBtn.textContent = 'Iniciar micrófono';
      micStatus.textContent = 'Micrófono inactivo';
      micStatus.classList.remove('status-on');
      micStatus.classList.add('status-off');
    }
  } catch (error) {
    micActive = false;
    micStatus.textContent = error.message;
    micStatus.classList.remove('status-on');
    micStatus.classList.add('status-off');
    console.error(error);
  }
});

profileButtons.forEach((button) => {
  button.addEventListener('click', () => {
    profileButtons.forEach((btn) => btn.classList.remove('active'));
    button.classList.add('active');
    const profile = voiceMasker.applyProfile(button.dataset.profile);
    if (profile) {
      pitchSlider.value = profile.pitch;
      distortionSlider.value = profile.distortion;
      lowpassSlider.value = profile.lowpass;
      updatePitchDisplay(profile.pitch);
      updateDistortionDisplay(profile.distortion);
      updateLowpassDisplay(profile.lowpass);
    }
  });
});

function populateVoices() {
  const voices = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
  voiceSelect.innerHTML = '';
  voices.forEach((voice, index) => {
    const option = document.createElement('option');
    option.value = voice.name;
    option.textContent = `${voice.lang} · ${voice.name}`;
    if (/es|ES/.test(voice.lang) && voiceSelect.childElementCount < 1) {
      option.selected = true;
    }
    voiceSelect.appendChild(option);
  });
  if (voiceSelect.options.length === 0) {
    const option = document.createElement('option');
    option.textContent = 'Voces no disponibles';
    option.disabled = true;
    option.selected = true;
    voiceSelect.appendChild(option);
  }
}

if (window.speechSynthesis) {
  populateVoices();
  window.speechSynthesis.onvoiceschanged = populateVoices;
}

speakBtn.addEventListener('click', () => {
  const textArea = document.getElementById('tts-text');
  const text = textArea.value.trim();
  if (!text) return;
  if (!window.speechSynthesis) {
    alert('La síntesis de voz no está disponible en este dispositivo.');
    return;
  }
  const utterance = new SpeechSynthesisUtterance(text);
  const voices = window.speechSynthesis.getVoices();
  const selectedVoice = voices.find((voice) => voice.name === voiceSelect.value);
  if (selectedVoice) {
    utterance.voice = selectedVoice;
  }
  const pitchValue = parseFloat(pitchSlider.value);
  utterance.pitch = Math.max(0.1, Math.min(2, pitchValue * 0.9));
  utterance.rate = 0.85;
  utterance.volume = 1;
  window.speechSynthesis.speak(utterance);
});

updatePitchDisplay(parseFloat(pitchSlider.value));
updateDistortionDisplay(parseFloat(distortionSlider.value));
updateLowpassDisplay(parseFloat(lowpassSlider.value));
