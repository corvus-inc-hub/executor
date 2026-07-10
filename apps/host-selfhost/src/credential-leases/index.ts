export {
  AwsRoleAssumptionError,
  makeAwsRoleAssumer,
  type AwsRoleAssumer,
  type AwsRoleAssumptionInput,
  type AwsRoleCredentials,
} from "./aws-role-assumer";
export { makeCredentialLeaseHandler } from "./handler";
export {
  CredentialLeaseError,
  decodeCredentialLeaseRequest,
  makeCredentialLeaseService,
  type CredentialLeaseDeps,
  type CredentialLeaseRequest,
  type CredentialLeaseResponse,
} from "./service";
