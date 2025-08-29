import {
  __export,
  hydrate
} from "./c-chunk-L4WJEK43.js";

// routes/ssr/stream.tsx
var stream_exports = {};
__export(stream_exports, {
  default: () => StreamPage,
  getServerSideProps: () => getServerSideProps
});
async function getServerSideProps() {
  return { chunks: ["Hello", " ", "from", " ", "streaming", "!"] };
}
function StreamPage(props) {
  return /* @__PURE__ */ React.createElement("main", { style: { fontFamily: "sans-serif", padding: 24 } }, /* @__PURE__ */ React.createElement("h1", null, "Streaming SSR"), /* @__PURE__ */ React.createElement("p", null, props.chunks.join("")));
}

// .oxian/assets/entries/ssr_stream.ts
hydrate(stream_exports);
//# sourceMappingURL=ssr_stream-NJZHXBC6.js.map
