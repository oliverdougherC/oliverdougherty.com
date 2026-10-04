import { type GlueMsg } from './messages';
/**
 * Glue is a simple binary protocol for serializing and deserializing messages.
 * It is inspired by protobuf, but much simpler.
 *
 * Interested in extending Glue? Open an issue on GitHub!
 */
type GlueType = 'str' | 'int' | 'float' | 'bool' | 'raw' | 'arr_str' | 'arr_int' | 'arr_float' | 'arr_bool' | 'arr_raw' | 'null';
export interface GlueField {
    type: GlueType;
    name: string;
    isNullable: boolean;
}
export interface GlueMessageProto {
    name: string;
    structName: string;
    className: string;
    fields: GlueField[];
}
export declare function glueDeserialize(buf: Uint8Array): GlueMsg;
export declare function glueSerialize(msg: GlueMsg): Uint8Array;
export {};
