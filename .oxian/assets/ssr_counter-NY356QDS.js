import {
  __export,
  hydrate
} from "./c-chunk-L4WJEK43.js";

// routes/ssr/counter.tsx
var counter_exports = {};
__export(counter_exports, {
  default: () => Counter,
  getServerSideProps: () => getServerSideProps
});
function getServerSideProps() {
  return { initial: 1 };
}
function Counter(props) {
  let count = props.initial;
  return /* @__PURE__ */ React.createElement("main", { style: { fontFamily: "sans-serif", padding: 24 } }, /* @__PURE__ */ React.createElement("h1", null, "Counter"), /* @__PURE__ */ React.createElement("p", null, "Initial from server: ", props.initial), /* @__PURE__ */ React.createElement("button", { onClick: (e) => {
    count++;
    e.currentTarget.nextSibling.textContent = String(count);
  } }, "+1"), /* @__PURE__ */ React.createElement("span", { style: { marginLeft: 12 } }, count));
}

// .oxian/assets/entries/ssr_counter.ts
hydrate(counter_exports);
//# sourceMappingURL=ssr_counter-NY356QDS.js.map
