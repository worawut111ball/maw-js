import { useFileAttach, FileInput, FileAttachMenu } from "../hooks/useFileAttach";
import { ChatBubbleSingle } from "../components/chat/ChatBubble";
import { mount } from "../core/mount";

function MobileFixture() {
  const { inputRef, mode, pickCamera, pickGallery, pickFile, onFileChange } = useFileAttach();
  return (
    <main style={{ minHeight: "100dvh", background: "#020208", color: "white", padding: 16 }}>
      <FileInput inputRef={inputRef} onChange={onFileChange} mode={mode} />
      <FileAttachMenu onCamera={pickCamera} onGallery={pickGallery} onFile={() => pickFile("file")} />
      <div style={{ marginTop: 24 }}>
        <ChatBubbleSingle
          entry={{
            ts: "2026-05-16 12:00:00",
            from: "neo-oracle",
            to: "mawjs",
            msg: "Fixture file https://example.test/report.txt\n```ts\nexport const answer = 42;\n```",
          }}
          isRight={false}
          highlighted={false}
          onToggle={() => {}}
        />
      </div>
    </main>
  );
}

mount(() => <MobileFixture />);
