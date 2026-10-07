import createError from '@fastify/error';
const UserValidationError = createError('ERR_USER_VALIDATION', 'User validation failed', 401);

export function validateUser(user, requiredProps = ['id', 'name', 'email']) {
  // Check if user exists
  if (!user) {
    throw new UserValidationError('User not found');
  }

  if (typeof user !== 'object') {
    throw new UserValidationError(`User is not an object, received ${typeof user}`);
  }

  // Check required properties
  const missingProps = [];
  for (const prop of requiredProps) {
    if (user[prop] === undefined || user[prop] === null || user[prop] === '') {
      missingProps.push(prop);
    }
  }

  if (missingProps.length > 0) {
    throw new UserValidationError(`User missing required properties: ${missingProps.join(', ')}`);
  }

  // Don't attempt to modify the user object directly, as some properties may be read-only
  // Instead, return a plain JavaScript object with the validated properties
  const validatedUser = {};

  // Copy all enumerable properties from the user object
  for (const prop in user) {
    if (Object.prototype.hasOwnProperty.call(user, prop)) {
      // For email, store lowercase version
      if (prop === 'email' && typeof user[prop] === 'string') {
        validatedUser[prop] = user[prop].toLowerCase();
      } else {
        validatedUser[prop] = user[prop];
      }
    }
  }

  // Ensure all required properties are copied
  for (const prop of requiredProps) {
    if (!(prop in validatedUser)) {
      validatedUser[prop] = user[prop];
    }
  }

  // If the original object is a class instance with methods, preserve important non-enumerable methods
  // by attaching them to our plain object (if accessible via getters)
  const methodsToPreserve = ['save', 'delete', 'update', 'toJSON'];
  for (const method of methodsToPreserve) {
    if (typeof user[method] === 'function') {
      validatedUser[method] = user[method].bind(user);
    }
  }

  return validatedUser;
}
