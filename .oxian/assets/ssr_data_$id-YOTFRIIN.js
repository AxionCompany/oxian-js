import {
  __export,
  hydrate
} from "./c-chunk-L4WJEK43.js";

// routes/ssr/data/[id].tsx
var id_exports = {};
__export(id_exports, {
  default: () => ItemPage,
  getServerSideProps: () => getServerSideProps
});
async function getServerSideProps(ctx) {
  const { id } = ctx.request.pathParams;
  const item = { id, title: `Item ${id}`, time: Date.now() };
  return { item };
}
function ItemPage(props) {
  return /* @__PURE__ */ React.createElement("main", { style: { fontFamily: "sans-serif", padding: 24 } }, /* @__PURE__ */ React.createElement("h1", null, props.item.title), /* @__PURE__ */ React.createElement("p", null, "ID: ", props.item.id), /* @__PURE__ */ React.createElement("p", null, "Server time: ", new Date(props.item.time).toISOString()));
}

// .oxian/assets/entries/ssr_data_$id.ts
hydrate(id_exports);
//# sourceMappingURL=ssr_data_$id-YOTFRIIN.js.map
