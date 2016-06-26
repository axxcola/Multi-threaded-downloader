/**
 * Created by tushar.mathur on 22/01/16.
 */

'use strict'

import PATH from 'path'
import URL from 'url'
import {Observable as O} from 'rx'
import R from 'ramda'
import * as Rx from './RxFP'
import {mux, demux} from 'muxer'
import {MTDError, FILE_SIZE_UNKNOWN} from './Error'

const first = R.nth(0)
const second = R.nth(1)
export const trace = R.curry((msg, value) => {
  console.log(msg, value)
  return value
})
export const demuxFP = R.curry((list, $) => demux($, ...list))
export const demuxFPH = R.curry((list, $) => R.head(demux($, ...list)))
export const BUFFER_SIZE = 512
export const NormalizePath = (path) => PATH.resolve(process.cwd(), path)
export const GenerateFileName = (x) => {
  return R.last(URL.parse(x).pathname.split('/')) || Date.now()
}
export const ResolvePath = R.compose(NormalizePath, GenerateFileName)
export const SplitRange = (totalBytes, range) => {
  const delta = Math.round(totalBytes / range)
  const start = R.times((x) => x * delta, range)
  const end = R.times((x) => (x + 1) * delta - 1, range)
  end[range - 1] = totalBytes
  return R.zip(start, end)
}
export const CreateRangeHeader = ([start, end]) => `bytes=${start}-${end}`
export const SetRangeHeader = ({request, range}) => {
  return R.set(
    R.lensPath(['headers', 'range']),
    CreateRangeHeader(range),
    R.omit(['threads', 'offsets'], request)
  )
}
export const CreateRequestParams = ({meta, index}) => {
  const range = [meta.offsets[index], second(meta.threads[index])]
  return SetRangeHeader({request: meta, range})
}
export const ToBuffer = R.curry((size, str) => {
  var buffer = CreateFilledBuffer(size)
  buffer.write(str)
  return buffer
})
export const CreateFilledBuffer = (size = BUFFER_SIZE, fill = ' ') => {
  const buffer = new Buffer(size)
  buffer.fill(fill)
  return buffer
}
export const MergeDefaultOptions = (options) => R.mergeAll([
  {mtdPath: options.path + '.mtd', range: 3, metaWrite: 300},
  options
])

// TODO: Use R.lens instead
export const GetOffset = R.curry((meta, index) => meta.offsets[index])
export const GetThread = R.curry((meta, index) => meta.threads[index])
export const GetThreadStart = R.curryN(2, R.compose(R.nth(0), GetThread))
export const GetThreadEnd = R.curryN(2, R.compose(R.nth(1), GetThread))
export const GetThreadCount = R.compose(R.length, R.prop('threads'))
export const TimesCount = R.times(R.identity)

/*
 * STREAM BASED
 */
export const GetBufferWriteOffset = ({buffer$, initialOffset}) => {
  const accumulator = ([_buffer, _offset], buffer) => [buffer, _buffer.length + _offset]
  return buffer$.scan(accumulator, [{length: 0}, initialOffset])
}
export const SetBufferParams = ({buffer$, index, meta}) => {
  const initialOffset = GetOffset(meta, index)
  const addParams = R.compose(Rx.map(R.append(index)), GetBufferWriteOffset)
  return addParams({buffer$, initialOffset})
}

/**
 * Makes an HTTP request using the {HttpRequest} function and appends the
 * buffer response with appropriate write position and thread index.
 * @function
 * @param {Object} HTTP - HTTP transformer
 * @param {function} HTTP.request - HTTP request function
 * @param {Object} r - a dict of meta and selected thread index
 * @param {Object} r.meta - the download meta info
 * @param {Object} r.index - index of the selected thread
 * @returns {Observable} a muxed {buffer$, response$}
 */
export const RequestThread = R.curry((HTTP, {meta, index}) => {
  const pluck = demuxFPH(['data$', 'response$'])
  const HttpRequest = R.compose(HTTP.request, CreateRequestParams)
  const {response$, data$} = pluck(HttpRequest({meta, index}))
  const buffer$ = SetBufferParams({buffer$: data$, meta, index})
  return mux({buffer$, response$})
})
export const ToJSON$ = source$ => source$.map(JSON.stringify.bind(JSON))
export const ToBuffer$ = source$ => source$.map(ToBuffer(BUFFER_SIZE))
export const JSToBuffer$ = R.compose(ToBuffer$, ToJSON$)
export const BufferToJS$ = buffer$ => {
  return buffer$.map(buffer => JSON.parse(buffer.toString()))
}
export const RemoteFileSize$ = ({HTTP, options}) => {
  return HTTP.requestHead(options)
    .pluck('headers', 'content-length')
    .map((x) => parseInt(x, 10))
}
export const LocalFileSize$ = ({FILE, fd$}) => {
  return FILE.fstat(fd$.map(R.of)).pluck('size')
}
export const PickFirst = R.map(first)
export const CreateMeta$ = ({size$, options}) => {
  return size$.map((totalBytes) => {
    if (!isFinite(totalBytes)) throw new MTDError(FILE_SIZE_UNKNOWN)
    const threads = SplitRange(totalBytes, options.range)
    return R.merge(options, {totalBytes, threads, offsets: PickFirst(threads)})
  })
}
export const ReadFileAt$ = ({FILE, fd$, position$, size = BUFFER_SIZE}) => {
  const readParams$ = O.combineLatest(position$, fd$)
  const buffer = CreateFilledBuffer(size)
  const toParam = ([position, fd]) => [fd, buffer, 0, buffer.length, position]
  return FILE.read(readParams$.map(toParam))
}
export const MetaPosition$ = ({size$}) => size$.map(R.add(-BUFFER_SIZE))
export const CreateWriteBufferAtParams = ({fd$, buffer$, position$}) => {
  const toParam = ([buffer, fd, position]) => [fd, buffer, 0, buffer.length, position]
  return O.combineLatest(buffer$, fd$, position$.first()).map(toParam)
}
export const CreateWriteBufferParams = ({fd$, buffer$}) => {
  const toParams = ([fd, buffer, position]) => [fd, buffer, 0, buffer.length, position]
  return O.combineLatest(fd$, buffer$).map(R.compose(toParams, R.unnest))
}
export const SetMetaOffsets = ({meta$, written$, thread$}) => {
  const offsetLens = thread => R.compose(R.lensProp('offsets'), R.lensIndex(thread))
  const start$ = meta$.map(meta => ({meta, len: 0, thread: 0})).first()
  const source$ = O.merge(
    start$,
    O.zip(written$, thread$)
      .map(R.zipObj(['len', 'thread']))
      .withLatestFrom(meta$.map(R.objOf('meta')))
      .map(R.mergeAll)
  )

  const accumulator = (previous, current) => {
    const thread = current.thread
    const pMeta = previous.meta
    const oldVal = pMeta.offsets[thread]
    const lens = offsetLens(thread)
    const meta = R.set(lens, R.add(oldVal, current.len), pMeta)
    return R.merge(current, {meta})
  }
  return source$
    .scan(accumulator)
    .skip(1)
    .pluck('meta')
}
export const ReadJSON$ = R.compose(BufferToJS$, Rx.map(second), ReadFileAt$)
export const IsOffsetInRange = R.curry((meta, i) => {
  const start = R.lte(GetThreadStart(meta, i))
  const end = R.gt(GetThreadEnd(meta, i))
  const inRange = R.allPass([start, end])
  return inRange(GetOffset(meta, i))
})
export const FlattenMeta$ = Rx.flatMap((meta) => {
  const MergeMeta = R.map(R.compose(R.merge({meta}), R.objOf('index')))
  const IsValid = R.filter(IsOffsetInRange(meta))
  return MergeMeta(IsValid(TimesCount(GetThreadCount(meta))))
})
export const RxThrottleComplete = (window$, $, sh) => {
  const selector = window => O.merge($.throttle(window, sh), $.last())
  return window$.first().flatMap(selector)
}
export const RemoveMeta = ({FILE, meta$, fd$}) => {
  const size$ = meta$.pluck('totalBytes')
  return FILE.truncate(O.combineLatest(fd$, size$).take(1))
}
export const ResetFileName = ({FILE, meta$}) => {
  const params$ = meta$.map(meta => [meta.mtdPath, meta.path]).take(1)
  return FILE.rename(params$)
}
export const IsCompleted$ = (meta$) => {
  const offsetsA = R.prop('offsets')
  const offsetsB = R.compose(R.map(second), R.prop('threads'))
  const subtract = R.apply(R.subtract)
  const diff = R.compose(R.all(R.lte(0)), R.map(subtract), R.zip)
  const isComplete = R.converge(diff, [offsetsA, offsetsB])
  return meta$.map(isComplete).distinctUntilChanged()
}
export const FinalizeDownload = ({FILE, fd$, meta$}) => {
  const metaRemoved$ = RemoveMeta({FILE, meta$, fd$})
  const renamed$ = metaRemoved$.flatMap(() => ResetFileName({FILE, meta$}))
  return mux({metaRemoved$, renamed$})
}

/**
 * Makes HTTP requests to start downloading data for each thread described in
 * the meta data.
 * @function
 * @param {Object} HTTP - an HTTP transformer
 * @param {function} HTTP.request - an HTTP transformer
 * @param {Observable} meta$ - meta data as a stream
 * @returns {Observable} - muxed stream of responses$ and buffer$
 */
export const RequestWithMeta = R.uncurryN(2, (HTTP) => R.compose(
  Rx.flatMap(RequestThread(HTTP)),
  FlattenMeta$
))
export const DownloadFromMTDFile = ({FILE, HTTP, mtdPath}) => {
  /**
   * Open file to read+append
   */
  const fd$ = FILE.open(O.just([mtdPath, 'r+']))

  /**
   * Retrieve File size on disk
   */
  const size$ = LocalFileSize$({FILE, fd$})

  /**
   * Retrieve Meta info
   */
  const metaPosition$ = MetaPosition$({size$})
  const meta$ = ReadJSON$({FILE, fd$, position$: metaPosition$})

  /**
   * Make a HTTP request for each thread
   */
  const {response$, buffer$} = demuxFPH(
    ['buffer$', 'response$'], RequestWithMeta(HTTP, meta$)
  )

  /**
   * Create write params and save buffer+offset to disk
   */
  const bufferWritten$ = FILE.write(
    CreateWriteBufferParams({FILE, fd$, buffer$})
  )

  /**
   * Update META info
   */
  const nMeta$ = SetMetaOffsets({
    meta$,
    written$: bufferWritten$.map(first),
    thread$: buffer$.map(R.nth(2))
  })

  /**
   * Persist META to disk
   */
  const metaWritten$ = FILE.write(CreateWriteBufferAtParams({
    fd$,
    buffer$: JSToBuffer$(RxThrottleComplete(meta$.pluck('metaWrite'), nMeta$)),
    position$: size$
  }))

  /**
   * Create sink$
   */
  return mux({
    metaWritten$, response$,
    localFileSize$: size$,
    fdR$: fd$, metaPosition$,
    meta$: O.merge(nMeta$, meta$)
  })
}
export const CreateMTDFile = ({FILE, HTTP, options}) => {
  /**
   * Create a new file
   */
  const fd$ = FILE.open(O.just([options.mtdPath, 'w']))

  /**
   * Retreive file size on remote server
   */
  const size$ = RemoteFileSize$({HTTP, options})

  /**
   * Create initial meta data
   */
  const meta$ = CreateMeta$({options, size$})

  /**
   * Create a new file with meta info appended at the end
   */
  const written$ = FILE.write(CreateWriteBufferAtParams({
    FILE,
    fd$: fd$,
    buffer$: JSToBuffer$(meta$),
    position$: size$
  }))
  return mux({written$, meta$, remoteFileSize$: size$, fdW$: fd$})
}
