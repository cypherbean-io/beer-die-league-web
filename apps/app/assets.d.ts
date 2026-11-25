// Metro bundles a font file as an asset and imports it as the asset's id.
declare module '*.ttf' {
  const asset: number;
  export default asset;
}
