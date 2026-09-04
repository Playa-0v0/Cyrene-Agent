/**
 * 保持为原生 CommonJS 文件，避免 TypeScript 把动态导入改写成 require()。
 * 独立文件也让测试运行器通过 Node.js 自己的模块加载器执行动态导入。
 */
module.exports = function importEsmModule(specifier) {
  return import(specifier);
};
