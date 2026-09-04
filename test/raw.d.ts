// Vite's ?raw suffix imports a file's contents as a string. Used by the suite to
// apply the real schema.sql rather than restating the DDL.
declare module "*.sql?raw" {
  const content: string;
  export default content;
}
