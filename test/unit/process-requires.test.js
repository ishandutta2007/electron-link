'use strict'

const assert = require('assert')
const dedent = require('dedent')
const path = require('path')
const recast = require('recast')
const processRequires = require('../../lib/process-requires')

suite('processRequires({baseDirPath, filePath, source, didFindRequire})', () => {
  test('simple require', () => {
    const source = dedent`
      const a = require('a')
      const b = require('b')
      function main () {
        const c = {a: b, b: a}
        return a + b
      }
    `
    assert.equal(
      recast.print(processRequires({source, didFindRequire: (mod) => mod === 'a'})).code,
      dedent`
        let a;

        function get_a() {
          return a = a || require('a');
        }

        const b = require('b')
        function main () {
          const c = {a: b, b: get_a()}
          return get_a() + b;
        }
      `
    )
  })

  test('conditional requires', () => {
    const source = dedent`
      let a, b;
      if (condition) {
        a = require('a')
        b = require('b')
      } else {
        a = require('c')
        b = require('d')
      }

      function main () {
        return a + b
      }
    `
    assert.equal(
      recast.print(processRequires({source, didFindRequire: (mod) => mod === 'a' || mod === 'c'})).code,
      dedent`
        let a, b;
        let get_a;
        if (condition) {
          get_a = function() {
            return a = a || require('a');
          }
          b = require('b')
        } else {
          get_a = function() {
            return a = a || require('c');
          }
          b = require('d')
        }

        function main () {
          return get_a() + b;
        }
      `
    )
  })

  test('top-level variables assignments that depend on previous requires', () => {
    const source = dedent`
      const a = require('a')
      const b = require('b')
      const c = require('c').foo.bar
      const d = c.X | c.Y | c.Z
      var e
      e = c.e
      const f = b.f
      function main () {
        c.qux()
        console.log(d)
        e()
      }
    `
    assert.equal(
      recast.print(processRequires({source, didFindRequire: (mod) => ['a', 'c'].indexOf(mod) >= 0})).code,
      dedent`
        let a;

        function get_a() {
          return a = a || require('a');
        }

        const b = require('b')
        let c;

        function get_c() {
          return c = c || require('c').foo.bar;
        }

        let d;

        function get_d() {
          return d = d || get_c().X | get_c().Y | get_c().Z;
        }

        var e
        function get_e() {
          return e = e || get_c().e;
        };
        const f = b.f
        function main () {
          get_c().qux()
          console.log(get_d())
          get_e()()
        }
    `)
  })

  test('top-level usage of deferred modules', () => {
    assert.throws(() => {
      processRequires({source: `var a = require('a'); a()`, didFindRequire: (mod) => true})
    })
    assert.throws(() => {
      processRequires({source: `require('a')()`, didFindRequire: (mod) => true})
    })
    assert.throws(() => {
      processRequires({source: `foo = require('a')`, didFindRequire: (mod) => true})
    })
    assert.throws(() => {
      processRequires({source: `module.exports.a = require('a')`, didFindRequire: (mod) => true})
    })
  })

  test('requires that appear in a closure wrapper defined in the top-level scope (e.g. CoffeeScript)', () => {
    const source = dedent`
      (function () {
        const a = require('a')
        const b = require('b')
        function main () {
          return a + b
        }
      }).call(this)

      (function () {
        const a = require('a')
        const b = require('b')
        function main () {
          return a + b
        }
      })()

      foo(function () {
        const b = require('b')
        const c = require('c')
        function main () {
          return b + c
        }
      })
    `
    assert.equal(
      recast.print(processRequires({source, didFindRequire: (mod) => mod === 'a' || mod === 'c'})).code,
      dedent`
        (function () {
          let a;

          function get_a() {
            return a = a || require('a');
          }

          const b = require('b')
          function main () {
            return get_a() + b;
          }
        }).call(this)

        (function () {
          let a;

          function get_a() {
            return a = a || require('a');
          }

          const b = require('b')
          function main () {
            return get_a() + b;
          }
        })()

        foo(function () {
          const b = require('b')
          const c = require('c')
          function main () {
            return b + c
          }
        })
      `
    )
  })

  test('references to shadowed variables', () => {
    const source = dedent`
      const a = require('a')
      function outer () {
        console.log(a)
        function inner () {
          console.log(a)
        }
        let a = []
      }

      function other () {
        console.log(a)
        function inner () {
          let a = []
          console.log(a)
        }
      }
    `
    assert.equal(
      recast.print(processRequires({source, didFindRequire: (mod) => mod === 'a'})).code,
      dedent`
        let a;

        function get_a() {
          return a = a || require('a');
        }

        function outer () {
          console.log(a)
          function inner () {
            console.log(a)
          }
          let a = []
        }

        function other () {
          console.log(get_a())
          function inner () {
            let a = []
            console.log(a)
          }
        }
      `
    )
  })

  test('references to globals', () => {
    const source = dedent`
      global.a = 1
      process.b = 2
      window.c = 3
      document.d = 4

      function inner () {
        const window = {}
        global.e = 4
        process.f = 5
        window.g = 6
        document.h = 7
      }
    `
    assert.equal(
      recast.print(processRequires({source, didFindRequire: (mod) => mod === 'a'})).code,
      dedent`
        get_global().a = 1
        get_process().b = 2
        get_window().c = 3
        get_document().d = 4

        function inner () {
          const window = {}
          get_global().e = 4
          get_process().f = 5
          window.g = 6
          get_document().h = 7
        }
      `
    )
  })

  test('multiple assignments separated by commas referencing deferred modules', () => {
    const source = dedent`
      let a, b, c, d, e, f;
      a = 1, b = 2, c = 3;
      d = require("d"), e = d.e, f = e.f;
    `
    assert.equal(
      recast.print(processRequires({source, didFindRequire: () => true})).code,
      dedent`
        let a, b, c, d, e, f;
        a = 1, b = 2, c = 3;

        function get_d() {
          return d = d || require("d");
        }

        function get_e() {
          return e = e || get_d().e;
        }

        function get_f() {
          return f = f || get_e().f;
        }
      `
    )
  })

  test('require with destructuring assignment', () => {
    const source = dedent`
      const {a, b, c} = require('module').foo

      function main() {
        a.bar()
      }
    `
    assert.equal(
      recast.print(processRequires({source, didFindRequire: () => true})).code,
      dedent`
        let {a, b, c} = {};

        function get_a() {
          return a = a || require('module').foo.a;
        }

        function get_b() {
          return b = b || require('module').foo.b;
        }

        function get_c() {
          return c = c || require('module').foo.c;
        }

        function main() {
          get_a().bar()
        }
      `
    )
  })

  test('JSON source', () => {
    const filePath = 'something.json'
    const source = '{"a": 1, "b": 2}'
    assert.equal(
      recast.print(processRequires({filePath, source, didFindRequire: () => false})).code,
      dedent`
        module.exports = {"a": 1, "b": 2}
      `
    )
  })

  test('path resolution', () => {
    const baseDirPath = path.resolve(__dirname, '..', 'fixtures', 'module')
    const filePath = path.join(baseDirPath, 'dir', 'entry.js')
    const source = dedent`
      const a = require('a')
      const b = require('./subdir/b')
      const c = require('c')
      const fs = require('fs')

      function inner () {
        require('./subdir/b')
        require.resolve('a')
        require.resolve('d')
        require('d')
      }
    `
    const requiredModules = []
    assert.equal(
      recast.print(processRequires({baseDirPath, filePath, source, didFindRequire: (mod) => {
        requiredModules.push(mod)
        return true
      }})).code,
      dedent`
        let a;

        function get_a() {
          return a = a || require("./node_modules/a/index.js");
        }

        let b;

        function get_b() {
          return b = b || require("./dir/subdir/b.js");
        }

        let c;

        function get_c() {
          return c = c || require('c');
        }

        let fs;

        function get_fs() {
          return fs = fs || require('fs');
        }

        function inner () {
          require("./dir/subdir/b.js")
          require.resolve("./node_modules/a/index.js")
          require.resolve('d')
          require('d')
        }
      `
    )
    assert.deepEqual(requiredModules, [
      path.join(baseDirPath, 'node_modules', 'a', 'index.js'),
      path.join(baseDirPath, 'dir', 'subdir', 'b.js'),
      'c',
      path.join(baseDirPath, 'dir', 'subdir', 'b.js'),
      'd'
    ])
  })
})
