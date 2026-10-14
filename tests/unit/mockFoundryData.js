/**
 * Stand-ins for the parts of Foundry's data layer that the write guard depends on: the update operators, the cleaning
 * of operator keys and serialized operators, and a field schema per mock document class. Each behaviour below was read
 * in the Foundry 14.364 source (`common/data/operators.mjs`, `common/utils/helpers.mjs`, `common/data/fields.mjs`) and
 * MEASURED live by the e2e suite. Not a test file (vitest only collects `*.test.js`). Every name is a `MOCK_` value.
 */

/** @type {symbol} Where an operator keeps its value, as in `common/data/operators.mjs`. */
export const OPERATOR_VALUE = Symbol('DataFieldOperatorValue');

/** @type {string} The key that marks a serialized operator. */
export const OPERATOR_IDENTIFIER = '__$OPERATOR$__';

/** Base class of the update operators. */
export class DataFieldOperator {
   /**
    * Build the operator.
    * @param {unknown} value - The value the operator carries.
    */
   constructor(value) {
      this[OPERATOR_VALUE] = value;
   }

   /**
    * Serialize as the wrapper object Foundry sends over the wire.
    * @returns {Record<string, unknown>} The wrapper.
    */
   toJSON() {
      return {
         [OPERATOR_IDENTIFIER]: this.constructor.name,
         value: this[OPERATOR_VALUE],
      };
   }

   /**
    * Create an operator of this class.
    * @param {unknown} value - The value to carry.
    * @returns {DataFieldOperator} An instance of the class it is called on.
    */
   static create(value) {
      return new this(value);
   }

   /**
    * Read the value inside an operator, or return anything else unchanged.
    * @param {unknown} value - An operator or a plain value.
    * @returns {unknown} The inner value.
    */
   static get(value) {
      return value instanceof DataFieldOperator ? value[OPERATOR_VALUE] : value;
   }
}

/** Deletes a field. */
export class ForcedDeletion extends DataFieldOperator {
   /** Build the deletion; it carries no value. */
   constructor() {
      super();
   }
}

/** Replaces a field without merging. */
export class ForcedReplacement extends DataFieldOperator {
   /**
    * Build the replacement.
    * @param {unknown} value - The new value.
    */
   constructor(value) {
      super(ForcedReplacement.get(value));
   }

   /**
    * Create a replacement wrapped in a proxy that exposes the keys of the inner value, so a scan that treats it as a
    * plain object sees the inner keys, as with Foundry's.
    * @param {unknown} value - The new value.
    * @returns {ForcedReplacement} The proxied replacement.
    */
   static create(value) {
      return new Proxy(new ForcedReplacement(value), {
         get(target, property, receiver) {
            if (Reflect.has(target, property)) {
               return Reflect.get(target, property, receiver);
            }
            const inner = target[OPERATOR_VALUE];
            return inner && typeof inner === 'object' ? Reflect.get(inner, property, receiver) : undefined;
         },
         ownKeys(target) {
            const inner = target[OPERATOR_VALUE];
            return inner && typeof inner === 'object' ? Reflect.ownKeys(inner) : [];
         },
         getOwnPropertyDescriptor(target, property) {
            const inner = target[OPERATOR_VALUE];
            if (inner && typeof inner === 'object') {
               const descriptor = Reflect.getOwnPropertyDescriptor(inner, property);
               if (descriptor?.configurable === false) {
                  Object.defineProperty(target, property, descriptor);
               }
               return descriptor;
            }
            return undefined;
         },
      });
   }
}

/**
 * Tell whether a key is an operator key, as Foundry's `isDeletionKey` does.
 * @param {unknown} key - A key.
 * @returns {boolean} True for `==name` and `-=name`.
 */
export function isDeletionKey(key) {
   return typeof key === 'string' && key[1] === '=' && (key[0] === '=' || key[0] === '-');
}

/**
 * Copy data the way `foundry.utils.deepClone` does: plain objects and arrays are copied, every other object (an
 * operator included) is returned as is.
 * @param {unknown} value - The data to copy.
 * @returns {unknown} The copy.
 */
export function cloneData(value) {
   if (typeof value !== 'object' || value === null) {
      return value;
   }
   if (Array.isArray(value)) {
      return value.map((member) => cloneData(member));
   }
   if (Object.getPrototypeOf(value) !== Object.prototype) {
      return value;
   }
   return Object.fromEntries(Object.entries(value).map(([key, member]) => [key, cloneData(member)]));
}

/**
 * Rebuild an operator from its serialized wrapper.
 * @param {Record<string, unknown>} wrapper - An object with the operator identifier key.
 * @returns {DataFieldOperator | undefined} The operator, or undefined for an identifier Foundry does not know (the
 * field is dropped).
 */
function reconstruct(wrapper) {
   if (wrapper[OPERATOR_IDENTIFIER] === 'ForcedDeletion') {
      return new ForcedDeletion();
   }
   if (wrapper[OPERATOR_IDENTIFIER] === 'ForcedReplacement') {
      return ForcedReplacement.create(wrapper.value);
   }
   return undefined;
}

/**
 * Turn operator keys and serialized operators into operator objects, in an already expanded tree, in place.
 * @param {unknown} node - The tree.
 * @returns {unknown} The converted tree.
 * @throws {Error} For a `-=` key whose value is not null, as Foundry does.
 */
export function convertOperators(node) {
   if (Array.isArray(node)) {
      return node.map((member) => convertOperators(member));
   }
   if (typeof node !== 'object' || node === null || Object.getPrototypeOf(node) !== Object.prototype) {
      return node;
   }
   /** @type {Record<string, unknown>} The converted object. */
   const result = {};
   for (const [key, value] of Object.entries(node)) {
      if (isDeletionKey(key)) {
         if (key[0] === '-') {
            if (value !== null) {
               throw new Error(`The key ${key} requires the value of that deletion key to be null`);
            }
            result[key.slice(2)] = new ForcedDeletion();
         } else {
            result[key.slice(2)] = ForcedReplacement.create(convertOperators(value));
         }
      } else if (typeof value === 'object' && value !== null && OPERATOR_IDENTIFIER in value) {
         const operator = reconstruct(value);
         if (operator !== undefined) {
            result[key] = operator;
         }
      } else {
         result[key] = convertOperators(value);
      }
   }
   return result;
}

/** Base of the mock fields. */
export class DataField {
   /**
    * Walk the rest of a path; a leaf field answers only for an empty rest.
    * @param {string[]} parts - The remaining segments, in reverse order.
    * @returns {DataField | undefined} The field, or undefined.
    */
   _getField(parts) {
      return parts.length > 0 ? undefined : this;
   }
}

/** A free-form object, as `flags`. */
export class ObjectField extends DataField {}

/** A set of named fields. */
export class SchemaField extends DataField {
   /**
    * Build the schema field.
    * @param {Record<string, DataField>} fields - The fields by name.
    */
   constructor(fields) {
      super();
      this.fields = fields;
   }

   /**
    * Find the field a path names, as `SchemaField#getField` does.
    * @param {string[] | string} path - Segments or a dotted path.
    * @param {{ source?: object }} [options] - The source data, used to find a data model by type.
    * @returns {DataField | undefined} The field, or undefined.
    */
   getField(path, { source } = {}) {
      return this._getField((typeof path === 'string' ? path.split('.') : path.slice()).reverse(), { source });
   }

   /** @override */
   _getField(parts, { source } = {}) {
      if (parts.length === 0) {
         return this;
      }
      const name = parts.pop();
      const field = this.fields[name];
      if (field === undefined) {
         return undefined;
      }
      /** @type {string | undefined} The type of the document, for a data model field. */
      let type;
      if (source !== undefined && source !== null) {
         if (typeof source !== 'object') {
            return undefined;
         }
         type = this.fields.type === undefined ? undefined : source.type;
         source = source[name] ?? null;
      }
      return field._getField(parts, { source, type });
   }
}

/** A list of one element type. */
export class ArrayField extends DataField {
   /**
    * Build the array field.
    * @param {DataField} element - The field every element of the array follows.
    */
   constructor(element) {
      super();
      this.element = element;
   }

   /** @override */
   _getField(parts, { source } = {}) {
      if (parts.length === 0) {
         return this;
      }
      const name = parts.pop();
      if (source !== undefined && source !== null) {
         if (!Array.isArray(source) || !Number.isInteger(Number(name)) || Number(name) < 0) {
            return undefined;
         }
         source = source[Number(name)] ?? null;
      }
      return this.element._getField(parts, { source });
   }
}

/** An object whose values all follow one element field. */
export class TypedObjectField extends ObjectField {
   /**
    * Build the field.
    * @param {DataField} element - The field every value of the object follows.
    */
   constructor(element) {
      super();
      this.element = element;
   }
}

/** A field whose value is one of several schemas, chosen by the value's `type`. */
export class TypedSchemaField extends ObjectField {
   /**
    * Build the field.
    * @param {Record<string, SchemaField>} types - The schema of each type name.
    */
   constructor(types) {
      super();
      this.types = types;
   }
}

/** A schema bound to a data model class. */
export class DataModelSchemaField extends SchemaField {
   /**
    * Build the field.
    * @param {{ schema: SchemaField }} model - The data model whose schema the field takes.
    */
   constructor(model) {
      super(model.schema.fields);
      this.model = model;
   }
}

/** A single embedded data model. */
export class EmbeddedDataField extends DataModelSchemaField {}

/** A single embedded document, such as the token's `delta`. */
export class EmbeddedDocumentField extends EmbeddedDataField {}

/** A collection of embedded documents. */
export class EmbeddedCollectionField extends ArrayField {
   /**
    * Build the field.
    * @param {{ schema: SchemaField }} model - The document class of the elements.
    */
   constructor(model) {
      super(model.schema);
      this.model = model;
   }

   /**
    * The schema of the element documents.
    * @returns {SchemaField} The schema of the model.
    */
   get schema() {
      return this.model.schema;
   }
}

/** A collection of embedded documents in a token delta. */
export class EmbeddedCollectionDeltaField extends EmbeddedCollectionField {}

/** The system data of a document, whose model depends on the document type. */
export class TypeDataField extends ObjectField {
   /**
    * Build the field.
    * @param {(type: string) => { schema: SchemaField } | null} modelFor - Finds the model of a type.
    */
   constructor(modelFor) {
      super();
      this.modelFor = modelFor;
   }

   /**
    * Find the data model of a document type.
    * @param {string} type - The document type, such as `npc`.
    * @returns {{ schema: SchemaField } | null} The model, or null.
    */
   getModelForType(type) {
      return this.modelFor(type);
   }

   /** @override */
   _getField(parts, { source, type } = {}) {
      if (parts.length === 0) {
         return this;
      }
      if (!type) {
         return undefined;
      }
      return this.getModelForType(type)?.schema?._getField(parts, { source });
   }
}

/** @type {object} The field classes, installed as `foundry.data.fields`. */
export const FIELD_CLASSES = {
   DataField,
   ObjectField,
   SchemaField,
   ArrayField,
   TypedObjectField,
   TypedSchemaField,
   DataModelSchemaField,
   EmbeddedDataField,
   EmbeddedDocumentField,
   EmbeddedCollectionField,
   EmbeddedCollectionDeltaField,
   TypeDataField,
};

/**
 * Build the schema of one mock document class.
 * @param {string} documentName - The document class name.
 * @param {Record<string, Function>} classes - Every mock class by name, resolved lazily.
 * @param {Record<string, string>} children - The embedded collections of the class: document name to collection name.
 * @returns {SchemaField} The schema built for the class.
 */
export function buildSchema(documentName, classes, children) {
   /** @type {Record<string, DataField>} The fields of the class. */
   const fields = {
      _id: new DataField(),
      name: new DataField(),
      type: new DataField(),
      flags: new ObjectField(),
      ownership: new ObjectField(),
   };
   if (documentName === 'Setting') {
      // A Setting has only these fields (`common/documents/setting.mjs`): no flags, ownership or type.
      return new SchemaField({
         _id: new DataField(),
         key: new DataField(),
         value: new DataField(),
         user: new DataField(),
      });
   }
   if (documentName === 'Actor' || documentName === 'Item') {
      /** @type {SchemaField} The system model of every type of this class. */
      const systemSchema = new SchemaField(
         documentName === 'Actor'
            ? {
               hp: new DataField(),
               attributes: new ObjectField(),
               bio: new EmbeddedDataField({ schema: new SchemaField({ text: new DataField() }) }),
            }
            : { damage: new DataField() },
      );
      fields.system = new TypeDataField(() => ({ schema: systemSchema }));
   }
   const delta = documentName === 'ActorDelta';
   for (const [name, collection] of Object.entries(children)) {
      fields[collection] = delta
         ? new EmbeddedCollectionDeltaField(classes[name])
         : new EmbeddedCollectionField(classes[name]);
   }
   if (documentName === 'Token') {
      fields.delta = new EmbeddedDocumentField(classes.ActorDelta);
   }
   return new SchemaField(fields);
}
