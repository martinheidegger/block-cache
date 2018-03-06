# Change Log

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

<a name="2.0.0"></a>
# [2.0.0](https://github.com/martinheidegger/block-cache/compare/v1.0.0...v2.0.0) (2018-03-06)


### Features

* **api:** Added disconnect api that allows the disconnection of a Cache instance from its `fs` ([f87135e](https://github.com/martinheidegger/block-cache/commit/f87135e))
* **api:** Exposed DEFAULT_CACHE_SIZE (10MB) in a tested fashion ([c2f6dbd](https://github.com/martinheidegger/block-cache/commit/c2f6dbd))
* **api:** New option prefix on Cache allows reuse of underlying lru-cache. ([2862257](https://github.com/martinheidegger/block-cache/commit/2862257))
* **freeze:** file pointers created through Cache.open and Cache.openSync are frozen now. ([e5a00ce](https://github.com/martinheidegger/block-cache/commit/e5a00ce))
* **freeze:** Using defineProperties for CachedFile properties to make sure that the instances are freezable. ([f3222c1](https://github.com/martinheidegger/block-cache/commit/f3222c1))
* **sandbox:** Sandboxing the Cache to make sure users of Cache can not access/modify the filesystem. ([ac90063](https://github.com/martinheidegger/block-cache/commit/ac90063))


### BREAKING CHANGES

* **sandbox:** The documented method `Cached.fd` and `Cached.prefix` were giving informations about the implementation details and they have been removed.



<a name="1.0.0"></a>
# 1.0.0 (2018-03-05)
