import {
  __export,
  hydrate
} from "./c-chunk-L4WJEK43.js";

// routes/home.tsx
var home_exports = {};
__export(home_exports, {
  default: () => Page,
  getServerSideProps: () => getServerSideProps
});
async function getServerSideProps() {
  return { message: "Hello from Oxian SSR", now: (/* @__PURE__ */ new Date()).toISOString() };
}
function Page(props) {
  return /* @__PURE__ */ React.createElement("main", { style: { fontFamily: "sans-serif", padding: 24 } }, /* @__PURE__ */ React.createElement("h1", null, props.message), /* @__PURE__ */ React.createElement("p", null, "Server time: ", props.now), /* @__PURE__ */ React.createElement("button", { type: "button", onClick: () => alert("Hydration works!") }, "Click me"));
}

// .oxian/assets/entries/home.ts
hydrate(home_exports);
//# sourceMappingURL=home-FIUKU2ZO.js.map
