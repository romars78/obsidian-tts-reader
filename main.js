/*
 * TTS Reader Plugin for Obsidian
 * 문서를 소리내어 읽어주는 플러그인
 * 한국어/영어/한자 지원, 모바일 호환
 */

"use strict";

const obsidian = require("obsidian");

// ─── 마크다운 → 순수 텍스트 변환 ───
function stripMarkdown(text) {
  return text
    .replace(/^---[\s\S]*?---\n*/m, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]*`/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[\[([^|\]]*\|)?([^\]]*)\]\]/g, "$2")
    .replace(/<[^>]+>/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
    .replace(/_{1,3}([^_]+)_{1,3}/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/==([^=]+)==/g, "$1")
    .replace(/^>\s?/gm, "")
    .replace(/^[-*_]{3,}\s*$/gm, "")
    .replace(/^[\s]*[-*+]\s+/gm, "")
    .replace(/^[\s]*\d+\.\s+/gm, "")
    .replace(/\[[ x]\]\s*/gi, "")
    .replace(/#[^\s#]+/g, "")
    .replace(/^\[![\w]+\][-+]?\s*/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ─── 기본 설정 ───
const DEFAULT_SETTINGS = {
  rate: 1.0,
  pitch: 1.0,
  voiceName: "",
};

// ─── 메인 플러그인 ───
class TtsReaderPlugin extends obsidian.Plugin {
  constructor() {
    super(...arguments);
    this.settings = Object.assign({}, DEFAULT_SETTINGS);
    this.synth = null;
    this.utterance = null;
    this.isPlaying = false;
    this.isPaused = false;
    this.statusBarEl = null;
    this.ribbonPlayEl = null;
    this.currentText = "";
    this.chunks = [];
    this.currentChunkIndex = 0;
    this.ttsAvailable = false;
  }

  async onload() {
    await this.loadSettings();

    // TTS 사용 가능 여부 확인
    this.checkTtsAvailability();

    // 리본 아이콘
    this.ribbonPlayEl = this.addRibbonIcon("audio-lines", "TTS: 문서 읽기", () => {
      if (this.isPlaying) {
        this.stopReading();
      } else {
        this.readDocument();
      }
    });

    // 상태바
    this.statusBarEl = this.addStatusBarItem();
    this.updateStatusBar();

    // 명령어 등록
    this.addCommand({
      id: "read-document",
      name: "전체 문서 읽기",
      callback: () => this.readDocument(),
    });

    this.addCommand({
      id: "read-selection",
      name: "선택 텍스트 읽기",
      callback: () => {
        const view = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
        if (!view) {
          new obsidian.Notice("열린 마크다운 문서가 없습니다");
          return;
        }
        let selection = "";
        try {
          if (view.editor) {
            selection = view.editor.getSelection();
          }
        } catch (e) {}
        if (selection) {
          this.readText(selection);
        } else {
          new obsidian.Notice("텍스트를 선택해주세요");
        }
      },
    });

    this.addCommand({
      id: "pause-resume",
      name: "일시정지 / 다시 재생",
      callback: () => this.togglePauseResume(),
    });

    this.addCommand({
      id: "stop-reading",
      name: "읽기 중지",
      callback: () => this.stopReading(),
    });

    this.addCommand({
      id: "rate-up",
      name: "속도 올리기 (+0.25)",
      callback: () => this.adjustRate(0.25),
    });

    this.addCommand({
      id: "rate-down",
      name: "속도 내리기 (-0.25)",
      callback: () => this.adjustRate(-0.25),
    });

    // 진단 명령어
    this.addCommand({
      id: "tts-diagnose",
      name: "TTS 진단 (문제 확인용)",
      callback: () => this.diagnose(),
    });

    this.addSettingTab(new TtsSettingTab(this.app, this));
    console.log("TTS Reader loaded");
  }

  // ─── TTS 사용 가능 여부 확인 ───
  checkTtsAvailability() {
    try {
      if (typeof window !== "undefined" && window.speechSynthesis) {
        this.synth = window.speechSynthesis;
        this.ttsAvailable = true;
      } else {
        this.ttsAvailable = false;
      }
    } catch (e) {
      this.ttsAvailable = false;
    }
  }

  // ─── 진단 ───
  diagnose() {
    const lines = [];
    lines.push("=== TTS 진단 결과 ===");

    // 1. 플랫폼
    const isMobile = obsidian.Platform ? (obsidian.Platform.isMobile ? "모바일" : "데스크탑") : "알 수 없음";
    lines.push("플랫폼: " + isMobile);

    // 2. speechSynthesis 존재
    const hasSynth = typeof window !== "undefined" && !!window.speechSynthesis;
    lines.push("speechSynthesis: " + (hasSynth ? "있음" : "없음"));

    // 3. 음성 목록
    if (hasSynth) {
      const voices = window.speechSynthesis.getVoices();
      lines.push("음성 수: " + voices.length);
      const koVoices = voices.filter((v) => v.lang && v.lang.startsWith("ko"));
      lines.push("한국어 음성: " + koVoices.length);
      if (koVoices.length > 0) {
        koVoices.forEach((v) => lines.push("  - " + v.name + " (" + v.lang + ")"));
      }
    }

    // 4. 현재 뷰
    const view = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
    lines.push("활성 뷰: " + (view ? "MarkdownView 있음" : "없음"));
    if (view) {
      lines.push("에디터: " + (view.editor ? "있음" : "없음"));
      lines.push("파일: " + (view.file ? view.file.name : "없음"));
      const mode = view.getMode ? view.getMode() : "알 수 없음";
      lines.push("모드: " + mode);
    }

    const msg = lines.join("\n");
    new obsidian.Notice(msg, 15000);
    console.log(msg);
  }

  onunload() {
    this.stopReading();
    console.log("TTS Reader unloaded");
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // ─── 문서 전체 읽기 ───
  readDocument() {
    try {
      // TTS 확인
      if (!this.ttsAvailable) {
        this.checkTtsAvailability();
        if (!this.ttsAvailable) {
          new obsidian.Notice("이 기기에서 TTS를 사용할 수 없습니다.\n명령어 'TTS 진단'을 실행해보세요.", 5000);
          return;
        }
      }

      const view = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      if (!view) {
        new obsidian.Notice("열린 마크다운 문서가 없습니다");
        return;
      }

      // 편집 모드: editor에서 가져오기
      let text = "";
      try {
        if (view.editor) {
          text = view.editor.getValue();
        }
      } catch (e) {
        console.log("TTS: editor 접근 실패", e);
      }

      // 읽기 모드 또는 editor 실패: file에서 가져오기
      if (!text) {
        try {
          const file = view.file;
          if (file) {
            this.app.vault.cachedRead(file).then((content) => {
              if (content && content.trim()) {
                this.readText(content);
              } else {
                new obsidian.Notice("문서가 비어있습니다");
              }
            }).catch((err) => {
              new obsidian.Notice("파일 읽기 실패: " + err.message);
            });
            return;
          } else {
            new obsidian.Notice("파일을 찾을 수 없습니다");
            return;
          }
        } catch (e) {
          new obsidian.Notice("문서 읽기 실패: " + e.message);
          return;
        }
      }

      if (!text.trim()) {
        new obsidian.Notice("문서가 비어있습니다");
        return;
      }
      this.readText(text);
    } catch (e) {
      new obsidian.Notice("오류 발생: " + e.message, 5000);
      console.error("TTS readDocument error:", e);
    }
  }

  // ─── 텍스트 읽기 (핵심) ───
  readText(rawText) {
    try {
      this.stopReading();

      const text = stripMarkdown(rawText);
      if (!text) {
        new obsidian.Notice("읽을 내용이 없습니다");
        return;
      }

      this.currentText = text;
      this.chunks = this.splitIntoChunks(text, 200);
      this.currentChunkIndex = 0;

      new obsidian.Notice("읽기 시작 (" + this.chunks.length + "개 단락)");
      this.isPlaying = true;
      this.isPaused = false;
      this.updateStatusBar();
      this.updateRibbonIcon();

      this.speakCurrentChunk();
    } catch (e) {
      new obsidian.Notice("읽기 시작 실패: " + e.message, 5000);
      console.error("TTS readText error:", e);
    }
  }

  splitIntoChunks(text, maxLength) {
    const chunks = [];
    const sentences = text.split(/(?<=[.?!。！？\n])\s*/);
    let current = "";

    for (const sentence of sentences) {
      if (!sentence.trim()) continue;
      if ((current + " " + sentence).length > maxLength && current) {
        chunks.push(current.trim());
        current = sentence;
      } else {
        current = current ? current + " " + sentence : sentence;
      }
    }
    if (current.trim()) {
      chunks.push(current.trim());
    }

    if (chunks.length === 0) {
      for (let i = 0; i < text.length; i += maxLength) {
        chunks.push(text.substring(i, i + maxLength));
      }
    }

    return chunks;
  }

  speakCurrentChunk() {
    try {
      if (this.currentChunkIndex >= this.chunks.length) {
        this.onFinished();
        return;
      }

      if (!this.synth) {
        new obsidian.Notice("speechSynthesis를 사용할 수 없습니다");
        this.stopReading();
        return;
      }

      const chunk = this.chunks[this.currentChunkIndex];
      this.utterance = new SpeechSynthesisUtterance(chunk);
      this.utterance.rate = this.settings.rate;
      this.utterance.pitch = this.settings.pitch;
      this.utterance.lang = "ko-KR";

      // 음성 선택
      if (this.settings.voiceName) {
        const voices = this.synth.getVoices();
        const voice = voices.find((v) => v.name === this.settings.voiceName);
        if (voice) {
          this.utterance.voice = voice;
          this.utterance.lang = voice.lang;
        }
      }

      this.utterance.onend = () => {
        this.currentChunkIndex++;
        if (this.isPlaying && !this.isPaused) {
          this.speakCurrentChunk();
        }
      };

      this.utterance.onerror = (event) => {
        if (event.error !== "canceled" && event.error !== "interrupted") {
          console.error("TTS error:", event.error);
          new obsidian.Notice("TTS 오류: " + event.error, 5000);
        }
        this.stopReading();
      };

      this.synth.speak(this.utterance);
    } catch (e) {
      new obsidian.Notice("음성 재생 실패: " + e.message, 5000);
      console.error("TTS speak error:", e);
      this.stopReading();
    }
  }

  onFinished() {
    this.isPlaying = false;
    this.isPaused = false;
    this.utterance = null;
    this.updateStatusBar();
    this.updateRibbonIcon();
    new obsidian.Notice("읽기 완료");
  }

  togglePauseResume() {
    if (!this.isPlaying) {
      this.readDocument();
      return;
    }

    if (this.isPaused) {
      this.synth.resume();
      this.isPaused = false;
      new obsidian.Notice("다시 재생");
    } else {
      this.synth.pause();
      this.isPaused = true;
      new obsidian.Notice("일시정지");
    }
    this.updateStatusBar();
  }

  stopReading() {
    try {
      if (this.synth) {
        this.synth.cancel();
      }
    } catch (e) {}
    this.isPlaying = false;
    this.isPaused = false;
    this.utterance = null;
    this.chunks = [];
    this.currentChunkIndex = 0;
    this.updateStatusBar();
    this.updateRibbonIcon();
  }

  adjustRate(delta) {
    this.settings.rate = Math.max(0.25, Math.min(4.0, this.settings.rate + delta));
    this.saveSettings();
    new obsidian.Notice("속도: " + this.settings.rate.toFixed(2) + "x");

    if (this.isPlaying) {
      try { this.synth.cancel(); } catch (e) {}
      this.speakCurrentChunk();
    }
  }

  updateStatusBar() {
    if (!this.statusBarEl) return;
    if (this.isPlaying && this.isPaused) {
      this.statusBarEl.setText("TTS ⏸ " + this.settings.rate.toFixed(2) + "x");
    } else if (this.isPlaying) {
      this.statusBarEl.setText("TTS ▶ " + this.settings.rate.toFixed(2) + "x");
    } else {
      this.statusBarEl.setText("TTS " + this.settings.rate.toFixed(2) + "x");
    }
  }

  updateRibbonIcon() {
    if (!this.ribbonPlayEl) return;
    if (this.isPlaying) {
      this.ribbonPlayEl.setAttribute("aria-label", "TTS: 읽기 중지");
    } else {
      this.ribbonPlayEl.setAttribute("aria-label", "TTS: 문서 읽기");
    }
  }
}

// ─── 설정 탭 ───
class TtsSettingTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "TTS Reader 설정" });

    // 속도
    new obsidian.Setting(containerEl)
      .setName("읽기 속도")
      .setDesc("0.25 ~ 4.0 (기본: 1.0)")
      .addSlider((slider) =>
        slider
          .setLimits(0.25, 4.0, 0.25)
          .setValue(this.plugin.settings.rate)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.rate = value;
            await this.plugin.saveSettings();
          })
      );

    // 피치
    new obsidian.Setting(containerEl)
      .setName("음높이 (pitch)")
      .setDesc("0.5 ~ 2.0 (기본: 1.0)")
      .addSlider((slider) =>
        slider
          .setLimits(0.5, 2.0, 0.1)
          .setValue(this.plugin.settings.pitch)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.pitch = value;
            await this.plugin.saveSettings();
          })
      );

    // 음성 선택
    const voiceSetting = new obsidian.Setting(containerEl)
      .setName("음성 선택")
      .setDesc("시스템에서 사용 가능한 음성 목록");

    const loadVoices = () => {
      try {
        const voices = window.speechSynthesis.getVoices();
        if (voices.length === 0) return;

        voiceSetting.addDropdown((dropdown) => {
          dropdown.addOption("", "시스템 기본값");

          const koVoices = voices.filter((v) => v.lang.startsWith("ko"));
          const enVoices = voices.filter((v) => v.lang.startsWith("en"));
          const otherVoices = voices.filter(
            (v) => !v.lang.startsWith("ko") && !v.lang.startsWith("en")
          );

          if (koVoices.length > 0) {
            koVoices.forEach((v) => {
              dropdown.addOption(v.name, "[한] " + v.name);
            });
          }
          if (enVoices.length > 0) {
            enVoices.forEach((v) => {
              dropdown.addOption(v.name, "[영] " + v.name);
            });
          }
          otherVoices.forEach((v) => {
            dropdown.addOption(v.name, v.name + " (" + v.lang + ")");
          });

          dropdown.setValue(this.plugin.settings.voiceName);
          dropdown.onChange(async (value) => {
            this.plugin.settings.voiceName = value;
            await this.plugin.saveSettings();
          });
        });
      } catch (e) {
        voiceSetting.setDesc("음성 목록을 불러올 수 없습니다: " + e.message);
      }
    };

    try {
      if (window.speechSynthesis.getVoices().length > 0) {
        loadVoices();
      } else {
        window.speechSynthesis.onvoiceschanged = () => loadVoices();
        // 일부 기기에서 onvoiceschanged가 안 불리는 경우 대비
        setTimeout(() => loadVoices(), 1000);
      }
    } catch (e) {
      voiceSetting.setDesc("이 기기에서 TTS를 사용할 수 없습니다");
    }

    // 테스트 버튼
    new obsidian.Setting(containerEl)
      .setName("음성 테스트")
      .setDesc("현재 설정으로 테스트 문장을 읽어봅니다")
      .addButton((button) =>
        button.setButtonText("테스트").onClick(() => {
          try {
            window.speechSynthesis.cancel();
            const utt = new SpeechSynthesisUtterance(
              "안녕하세요. TTS 리더 테스트입니다."
            );
            utt.rate = this.plugin.settings.rate;
            utt.pitch = this.plugin.settings.pitch;
            utt.lang = "ko-KR";

            if (this.plugin.settings.voiceName) {
              const voices = window.speechSynthesis.getVoices();
              const voice = voices.find((v) => v.name === this.plugin.settings.voiceName);
              if (voice) {
                utt.voice = voice;
                utt.lang = voice.lang;
              }
            }

            window.speechSynthesis.speak(utt);
          } catch (e) {
            new obsidian.Notice("테스트 실패: " + e.message, 5000);
          }
        })
      );

    // 진단 버튼
    new obsidian.Setting(containerEl)
      .setName("진단")
      .setDesc("TTS 문제를 확인합니다")
      .addButton((button) =>
        button.setButtonText("진단 실행").onClick(() => {
          this.plugin.diagnose();
        })
      );
  }
}

module.exports = TtsReaderPlugin;
