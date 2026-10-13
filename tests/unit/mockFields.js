/**
 * Stand-ins for Foundry's schema field classes, with the same class names, inheritance and the properties the schema
 * walker reads. Not a test file (vitest only collects `*.test.js`).
 */

/** The base of every field. */
export class DataField {
   /**
    * Build a field.
    * @param {Record<string, unknown>} [options] - Properties assigned to the field.
    */
   constructor(options = {}) {
      /** @type {boolean} Whether the field is required. */
      this.required = false;
      /** @type {boolean} Whether the field may be null. */
      this.nullable = false;
      Object.assign(this, options);
   }
}

export class BooleanField extends DataField {}

export class NumberField extends DataField {}

export class StringField extends DataField {
   /**
    * Build a string field.
    * @param {Record<string, unknown>} [options] - Properties assigned to the field.
    */
   constructor(options = {}) {
      super({
         blank: false,
         ...options,
      });
   }
}

export class DocumentIdField extends StringField {}

export class DocumentUUIDField extends StringField {}

export class ForeignDocumentField extends DocumentIdField {}

export class ColorField extends StringField {}

export class FilePathField extends StringField {}

export class HTMLField extends StringField {}

export class JSONField extends StringField {}

export class ObjectField extends DataField {}

export class AnyField extends DataField {}

export class TypedObjectField extends ObjectField {}

export class DocumentFlagsField extends TypedObjectField {}

export class TypeDataField extends ObjectField {}

export class TypedSchemaField extends DataField {}

export class SchemaField extends DataField {
   /**
    * Build a schema field.
    * @param {Record<string, DataField>} fields - The child fields.
    * @param {Record<string, unknown>} [options] - Properties assigned to the field.
    */
   constructor(fields, options = {}) {
      super(options);
      /** @type {Record<string, DataField>} The child fields. */
      this.fields = fields;
   }
}

export class DataModelSchemaField extends SchemaField {}

export class EmbeddedDataField extends DataModelSchemaField {}

export class EmbeddedDocumentField extends EmbeddedDataField {}

export class DocumentStatsField extends SchemaField {}

export class ArrayField extends DataField {
   /**
    * Build an array field.
    * @param {DataField | { documentName: string }} element - The element field, or the document class of a collection.
    * @param {Record<string, unknown>} [options] - Properties assigned to the field.
    */
   constructor(element, options = {}) {
      super(options);
      /** @type {unknown} The element field. */
      this.element = element;
   }
}

export class SetField extends ArrayField {}

export class EmbeddedCollectionField extends ArrayField {}

export class EmbeddedCollectionDeltaField extends EmbeddedCollectionField {}
